const { readTemplate } = require('cfn-read-template');
const { pack } = require('npm-lambda-pack');
const parallel = require('run-parallel');
const { dirname, join, resolve } = require('path');
const { readFile } = require('fs');
const readJson = require('read-json');
const { homedir } = require('os');
const JSZip = require('jszip');
const { zipFiles } = require('jszip-glob');
const { createHash } = require('crypto');
const AWS = require('aws-sdk');

const packageResourceMap = {
  'AWS::Serverless::Function': 'CodeUri',
  'AWS::Serverless::Api': 'DefinitionUri',
  'AWS::ApiGateway::RestApi': 'BodyS3Location',
  'AWS::Lambda::Function': 'Code',
  'AWS::AppSync::GraphQLSchema': 'DefinitionS3Location',
  'AWS::AppSync::Resolver': 'RequestMappingTemplateS3Location',
  'AWS::AppSync::Resolver': 'ResponseMappingTemplateS3Location',
  'AWS::ElasticBeanstalk::Application-Version': 'SourceBundle',
  'AWS::CloudFormation::Stack': 'TemplateURL',
  'AWS::Include': 'Location',
};

function packageTemplate(options, callback) {
  options = { ...options };

  if (options.basedir === undefined) {
    options.basedir = dirname(options.templateFile);
  }

  options.templateDir = dirname(options.templateFile);

  parallel({
    template: callback => readTemplate(options.templateFile, callback),

    StackResources: callback => {
      if (!options.updateFunctions) {
        return callback(null, {});
      }

      const cloudformation = new AWS.CloudFormation();

      const params = {
        StackName: options.stackName,
      };

      cloudformation.describeStackResources(params, (err, data) => {
        if (err) {
          return callback(err);
        }

        const result = {};

        data.StackResources.forEach(resource => {
          result[resource.LogicalResourceId] = resource;
        });

        callback(null, result);
      });
    },
  }, (err, result) => {
    if (err) {
      return callback(err);
    }

    const { template, StackResources } = result;

    const { Resources } = template;

    if (typeof Resources !== 'object') {
      return callback(new Error('Resources must be an object.'));
    }

    options.Resources = Resources;
    options.StackResources = StackResources;

    parallel(makeResourceTasks(options), err => {
      if (err) {
        return callback(err);
      }

      callback(null, template);
    });
  });
}

function makeResourceTasks(options) {
  const s3 = new AWS.S3();
  const lambda = options.updateFunctions ? (new AWS.Lambda()) : null;

  return Object.entries(options.Resources).map(([logicalId, resource]) => callback => {
    const { Type } = resource;

    if (options.updateFunctions && Type !== 'AWS::Serverless::Function' && Type !== 'AWS::Lambda::Function') {
      return callback(null);
    }

    /*
     * Ignore resources that have no local artifacts.
     */
    const propertyName = packageResourceMap[Type];

    if (propertyName === undefined) {
      return callback(null);
    }

    /*
     * Validate Properties.
     */
    const { Properties } = resource;

    if (Properties === undefined) {
      return callback(null);
    }

    if (typeof Properties !== 'object') {
      return callback(new Error(`Resources.${logicalId}.Properties must be an object.`));
    }

    /*
     * Ignore the property if no local artifacts.
     */
    const value = Properties[propertyName];

    if (typeof value !== 'string' || value.startsWith('s3:')) {
      return callback(null);
    }

    /*
     * Read local artifacts.
     */
    const artifactPath = resolve(options.templateDir, value);

    readFile(artifactPath, (err, file) => {
      if (!err) {
        return upload(file);
      }

      if (err.code !== 'EISDIR') {
        return callback(err);
      }

      const packer = (Type === 'AWS::Serverless::Function' || Type === 'AWS::Lambda::Function')
        ? packFunction : packDirectory;

      return packer(artifactPath, options, (err, file, thumbprint) => {
        if (err) {
          return callback(err);
        }

        upload(file, thumbprint);
      });
    });

    /*
     * Upload the artifact.
     */
    function upload(body, thumbprint) {
      const {
        bucket,
        prefix,
        logger = console,
      } = options;

      const md5OfBody = md5(body);
      const shortMd5 = thumbprint ? thumbprint.substr(0, 16) : md5OfBody.substr(0, 16);

      const key = prefix === undefined
        ? `${logicalId}-${shortMd5}`
        : `${prefix}/${logicalId}-${shortMd5}`;

      const s3url = `s3://${bucket}/${key}`;

      const params = {
        Bucket: bucket,
        Key: key,
        IfNoneMatch: `"${md5OfBody}"`,
      };

      s3.headObject(params, (err, data) => {
        if (err) {
          const { statusCode } = err;

          if (statusCode === 304) {
            logger.log('Artifact %s of resource %s not modified', artifactPath, logicalId);

            Properties[propertyName] = s3url;
            return callback(null);
          }

          if (statusCode !== 200 && statusCode !== 404) {
            return callback(new Error(`Response ${res.statusCode} ${res.statusMessage} from S3`));
          }
        }

        logger.log('Artifact %s of resource %s is uploading to %s',
          artifactPath, logicalId, s3url);

        const params = {
          Bucket: bucket,
          Key: key,
          Body: body,
        };

        s3.putObject(params, (err, data) => {
          if (err) {
            return callback(err);
          }

          Properties[propertyName] = s3url;

          if (!options.updateFunctions) {
            return callback(null);
          }

          const stackResource = options.StackResources[logicalId];

          if (!stackResource) {
            return callback(new Error(`The resource '${logicalId}' in the stack is not found`));
          }

          const FunctionName = stackResource.PhysicalResourceId[0];

          const params = {
            FunctionName,
            S3Bucket: bucket,
            S3Key: key,
          };

          lambda.updateFunctionCode(params, (err, data) => {
            if (err) {
              return callback(new Error(`Updating the function '${FunctionName}' is failed`));
            }

            logger.log('Function %s updated', FunctionName);

            callback(null);
          });
        });
      });
    }
  });
}

function packFunction(pkgDir, options, callback) {
  readJson(join(pkgDir, 'package.json'), (err, pkgJson) => {
    if (err) {
      return callback(err);
    }

    pack({
      pkgJson,
      pkgDir,
      cacheBaseDir: `${homedir()}/.cfn-package`,
    }, (err, result) => {
      if (err) {
        return callback(err);
      }

      const { thumbprint, zip } = result;

      zip.generateAsync({
        type: 'nodebuffer',
        platform: process.platform,
        compression: 'DEFLATE',
        compressionOptions: {
          level: 9,
        },
      }).then(data => callback(null, data, thumbprint))
        .catch(err => callback(err));
    });
  });
}

function packDirectory(dir, options, callback) {
  zipFiles('**', {
    cwd: dir,
    dot: true,
    nodir: true,
    nosort: true,
    zip: new JSZip(),
  }, (err, zip) => {
    if (err) {
      return callback(err);
    }

    zip.generateAsync({
      type: 'nodebuffer',
      platform: process.platform,
      compression: 'DEFLATE',
      compressionOptions: {
        level: 9,
      },
    }).then(data => callback(null, data))
      .catch(err => callback(err));
  });
}

function md5(data) {
  const md5 = createHash('md5');
  md5.update(data);
  return md5.digest('hex');
}

/*
 * Exports.
 */
exports.packageTemplate = packageTemplate;
