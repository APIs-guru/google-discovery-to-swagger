const fs = require('fs');
const converter = require('./index.js');

const filename = process.argv[2];
if (!filename) process.exit(0);

const s = fs.readFileSync(filename,'utf8');
const o = JSON.parse(s);

const openapi = converter.convert(o);
const out = JSON.stringify(openapi,null,2);

fs.writeFileSync('./openapi.json',out,'utf8');
