const Google2Swagger = require('./index');
const _ = require('lodash');
const axios = require('axios');
const yaml = require('js-yaml');

const MAX_API_VERSION = 5;
const service = process.argv[2];
const maybeSpecificVersion = process.argv[3];

const possibleDiscoveryUrls = buildPossibleDiscoveryUrls();

function buildPossibleDiscoveryUrls() {
  if (maybeSpecificVersion) {
    return getDiscoveryUrls(maybeSpecificVersion);
  }

  return _.flatten(_.range(1, MAX_API_VERSION + 1).map(version => getDiscoveryUrls(`v${version}`)));
}

function getDiscoveryUrls(version) {
  return [
    `https://${service}.googleapis.com/$discovery/rest?version=${version}`,
    `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`
  ]
}

function convertGoogleDiscoveryToSwagger(response) {
  const swagger2Json = Google2Swagger.convert(response.data);
  
  const swagger2Yaml = yaml.safeDump(yaml.safeLoad(JSON.stringify(swagger2Json, null, 2)), {
    lineWidth: -1 // don't generate line folds
  });

  console.log(swagger2Yaml);
};

function getApiDiscovery(index) {
  if (index > possibleDiscoveryUrls.length){
    console.error("can't find api discovery.");
    return;
  }

  const discoveryUrl = possibleDiscoveryUrls[index];

  axios.get(discoveryUrl)
    .then(convertGoogleDiscoveryToSwagger)
    .catch(function (error) {
      getApiDiscovery(index + 1);
    });
}

getApiDiscovery(0);
