const test = require('tape');
const { packageTemplate } = require('..');

test('test', t => {
  t.plan(2);

  packageTemplate({
    bucket: 'node-tmp',
    prefix: 'cfn-package/test',
    templateFile: `${__dirname}/template.yaml`,
  }, (err, template) => {
    t.error(err);
    t.ok(template.Resources.file.Properties.CodeUri.startsWith('s3://'));
  });
});
