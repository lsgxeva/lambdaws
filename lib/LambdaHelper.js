var Q = require('q'),
    md5 = require('MD5');
    zip = require('node-zip'),
    uuid = require('uuid'),
    extend = require('extend'),
    fs = require('fs'),
    path = require('path'),
    zipper = require('./zipper'),
    uploadHelper = require('./UploadHelper');

var lambda = null,
    _defaultFunctionSettings = {
        memory: 128, // mb
        description: '',
        timeout: 3  // seconds
    };

var _getFunctionHash  = function (func) {
    return md5(func.toString());
    // TODO : add config in hash
};

var _getModuleHash = function (modulePath, handlerName, deps, configs) {
    var configsAsStr = JSON.stringify(configs),
        identifier = [global.constants.MODULE_HASH_PREFIX, modulePath, handlerName, deps, configsAsStr].join('_');

    return md5(identifier);
};

var _loadModule = function(moduleName) {
    return require(moduleName); // TODO throw better errors if require fails
};

var _lambdaize = function (userFunc) {
    function __lambda__ (event, context) {
        var LambdaError = function() {};
        // TODO (Next iteration) Move requires elsewhere
        var AWS_sdk = require('aws-sdk'),
        sqs_svc = new AWS_sdk.SQS();
        
        function _sendToSqs(data, afterSentCallback) {
            var params = {
                MessageBody: JSON.stringify(data),
                QueueUrl: event.sqsQueueUrl
            };
            sqs_svc.sendMessage(params, function(err) {
                if(err) console.log('Error sending response to sqs'); 
                afterSentCallback();
            });
        }

        function _newCallback(arg) {
            var finishExecution = function() { context.done(null, "Lambdaws done"); };
            var success = !(arg instanceof LambdaError);
            _sendToSqs({success: success, data: arg, requestId: context.invokeid}, finishExecution);
        }

        event.args.push(_newCallback);

        var func = /*user function*/null;

        try {
            func.apply(this, event.args);
        }
        catch(error) {
            var objectifyError = function(err) {
                return Object.getOwnPropertyNames(err).reduce(function(a, c) {
                    a[c] = err[c];
                    return a;
                }, new LambdaError());
            };
            _newCallback(objectifyError(error));
        }
    }

    return __lambda__.toString().replace('/*user function*/null', userFunc.toString());
}

var _lambdaizeModule = function(handlerName) {
    var functionToCall = typeof(handlerName) === 'string' ? '.' + handlerName : '';

    // Requiring the function in module
    var outputModuleCode = "var m = require('./module.js')" + functionToCall + ";";
    var instrumentedFunction = _lambdaize('m'),
        instrumentedFunctionWithoutName = instrumentedFunction.replace('function __lambda__', 'function');

    // Exporting the instrumented module call
    outputModuleCode += "exports." + global.constants.MODULE_DEFAULT_HANDLER + " = " + instrumentedFunctionWithoutName;
    return outputModuleCode;
}

var _createProxy = function (executionStore, queueInitializedPromise, promise) {
    function proxy() {
        var args = Array.prototype.slice.call(arguments);
        if (typeof(args[args.length - 1]) !== 'function') {
            throw "Expected last argument to be a callback";
        }

        var callb = args.pop();
        promise.fail(function(err) {console.log(err);});
        Q.all([queueInitializedPromise, promise]).spread(function (queueUrl, uploadData) {
            var params = {
                FunctionName: uploadData.FunctionName,
                InvokeArgs: JSON.stringify({
                    args: args,
                    sqsQueueUrl: queueUrl
                })
            };

            var req = lambda.invokeAsync(params).
            on('success', function(data) {
                executionStore[data.requestId] = callb;
            }).
            on('error', function(err) {
                callb(err, null);
            }).
            send();

        });

        promise.catch(function () {
            throw "Could not upload function to S3";
        });
    }

    return proxy;
};


module.exports = function (aws, queueInitializedPromise, executionStore) {
    var proxyStore = {};
    lambda = new aws.Lambda();
    // this is temporary until a decent plugin module is developed
    this.createProxy = _createProxy;
    this.uploader = uploadHelper(lambda);

    this.getCloudedFunctionFromFunction = function (func, deps, configs) {
        var functionConfig = extend(true, {}, _defaultFunctionSettings, configs);
        var functionIdentifier = _getFunctionHash(func);

        if (!proxyStore.hasOwnProperty(functionIdentifier)) {
            var lambdaFunc = _lambdaize(func);
            var functionAsString = 'exports.' + global.constants.MODULE_DEFAULT_HANDLER + '=' + lambdaFunc + ';';

            var zippedFunction  = zipper.zipFunction(functionAsString, deps),
                uploadPromise   = this.uploader(zippedFunction, functionConfig, functionIdentifier);
            
            proxyStore[functionIdentifier] = this.createProxy(executionStore, queueInitializedPromise, uploadPromise);
        }

        return proxyStore[functionIdentifier];
    };

    this.getCloudedFunctionFromModule = function(modulePath, handlerName, deps, configs) {
        var functionConfig = extend(true, {}, _defaultFunctionSettings, configs);
        // TODO : replace getmodulehash and get function hash for a single function
        // TODO : md5 module and include it in the hash function
        var functionIdentifier = _getModuleHash(modulePath, handlerName, deps, functionConfig);
        
        if(!proxyStore.hasOwnProperty(functionIdentifier)) {
            var _module = _loadModule(modulePath);

            if(typeof(handlerName) === 'string') {
                // Check if function exists in module object
                if(typeof(_module) !== 'object') {
                    throw Error('Expected the module to return an object when handlerName is not empty');
                }
                if(!_module.hasOwnProperty(handlerName) || typeof(_module[handlerName]) !== 'function') {
                    throw  Error('Expected module to have a function called ' + handlerName);
                }
            } else {
                // Check that module is a function
                if(typeof(_module) !== 'function') {
                    throw Error('Expected the module to be a function since handlerName was not specified');
                }
            }

            var moduleOverride  = _lambdaizeModule(handlerName);
            var zippedModule    = zipper.zipModule(moduleOverride, modulePath, deps);
            var uploadPromise   = this.uploader(zippedModule, functionConfig, functionIdentifier);

            proxyStore[functionIdentifier] = this.createProxy(executionStore, queueInitializedPromise, uploadPromise);
        }

        return proxyStore[functionIdentifier];
    };

    this.getCloudedFunctionFromZip = function(zipContent, configs) {
        var functionConfig = extend(true, {}, _defaultFunctionSettings, configs);
        var functionIdentifier = md5(zipContent);

        if(!proxyStore.hasOwnProperty(functionIdentifier)) {
            var uploadPromise = this.uploader(zipContent, functionConfig, functionIdentifier);
            proxyStore[functionIdentifier] = this.createProxy(executionStore, queueInitializedPromise, uploadPromise);
        }

        return proxyStore[functionIdentifier];
    }
};
