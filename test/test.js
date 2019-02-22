const test = require('tape');
const { packageTemplate } = require('..');
const { makeSigner } = require('aws4-with-assume-role');

test('test', t => {
  t.plan(2);

  makeSigner((err, sign) => {
    if (err) {
      throw err;
    }

    packageTemplate({
      bucket: 'node-tmp',
      prefix: 'cfn-package/test',
      templateFile: `${__dirname}/template.yaml`,
      sign,
    }, (err, template) => {
      t.error(err);
      t.ok(template.Resources.file.Properties.CodeUri.startsWith('s3://'));
    });
  });
});
