'use strict';

var converter = require('../../src/index.js'),
    AssertionError = require('assert').AssertionError,
	expect = require('chai').expect,
	_ = require('lodash'),
	mkGdd;

describe('discover2swagger', function() {

  describe('successful conversions', function() {

	it('a simple GDD should be converted', function() {
	  var swag = converter.convert(mkGdd());
	  expect(swag.paths['/resource']).to.exist;
	  swag;
	});

  });

  describe('error messages when processing parameters', function() {

	it('an unsupported location', function() {
	  var aGdd = mkGdd(),
	      swag;

	  aGdd.resources.resource.methods.list.parameters.p1.location = 'foo';
	  try {
		converter.convert(aGdd);
	  } catch(e) {
		expect(e).to.be.an.instanceof(AssertionError);
		expect(e.message).to.eq('There was a problem processing the parameter, p1, ' +
								'error:  parameter location must be \'query\' or \'path\'; was \'foo\'.');
	  }
	});

	it('an unsupported type', function() {
	  var aGdd = mkGdd(),
	      swag;

	  aGdd.resources.resource.methods.list.parameters.p1.type = 'foo';
	  try {
		converter.convert(aGdd);
	  } catch(e) {
		expect(e).to.be.an.instanceof(AssertionError);
		expect(e.message).to.eq('There was a problem processing the parameter, p1, ' +
								'error:  parameter type must be one of \'string\', ' +
								'\'number\', \'integer\', \'boolean\'; was \'foo\'');
	  }
	});

  });

});

function mkGdd() {
  return {
	  id: "v1.an-api",
	  name: "An API",
	  version: "1.0",
	  kind: "discovery#restDescription",
	  discoveryVersion: "v1",
	  protocol: "rest",
	  servicePath: "v1/an-api/",
	  resources: {
		resource: {
		  methods: {
			list: {
			  id: "resource.list",
			  path: "resource",
			  httpMethod: "GET",
			  parameters: {
				p1: {
				  type: "string",
				  location: "query"
				},
				p2: {
				  type: "string",
				  location: "query"
				}
			  },
			  response: {
				$ref: "#schemas/ResourceList"
			  }
			}
		  }
		}
	  },
	  schemas: {
		ResourceList: {
		  title: "A List",
		  type: "object",
		  properties: {
			hi: {
			  type: "string"
			}
		  }
		}
	  }
	};
}

