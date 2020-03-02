# google-discovery-to-swagger

Script for converting Google Discovery format into Swagger 2.0

## Usage

```
$ npm install
$ node src/main.js [SERVICE_NAME] [VERSION] > file.yml
```

The script will automatically try to use the following urls to get the API discovery file:
```
https://${service}.googleapis.com/$discovery/rest?version=${version}
https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest
```

If `VERSION` is not specified the script will try versions 1-5.

Examples:
```
node src/main.js clouddebugger > raw_gcp_stackdriver_debugger.yml
node src/main.js container > raw_gcp_container_engine.yml
node src/main.js vision > raw_gcp_cloud_vision.yml
node src/main.js logging > raw_gcp_stackdriver_logging.yml
node src/main.js monitoring > raw_gcp_stackdriver_monitoring.yml
node src/main.js compute > raw_gcp_compute_engine.yml
node src/main.js datastore > raw_gcp_cloud_datastore.yml
node src/main.js cloudprofiler > raw_gcp_stackdriver_profiler.yml
node src/main.js cloudtrace > raw_gcp_stackdriver_trace.yml
node src/main.js language > raw_gcp_cloud_natural_language.yml
node src/main.js pubsub > raw_gcp_cloud_pubsub.yml
node src/main.js bigquery > raw_gcp_bigquery.yml
node src/main.js storage > raw_gcp_cloud_storage.yml 
node src/main.js clouderrorreporting v1beta1 > raw_gcp_stackdriver_errors.yml
```

You can see in the last example we have to specify the version because it's not just a number.

## Credits
[Ivan Goncharov](https://github.com/IvanGoncharov/)

## License

MIT
