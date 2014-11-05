/*!
 * Backbone SDK for Sails and Socket.io
 * (override for Backbone.sync and Backbone.Collection)
 *
 * c. 2013 @mikermcneil
 * MIT Licensed
 *
 *
 * Inspired by:
 * backbone.iobind - Backbone.sync replacement
 * Copyright(c) 2011 Jake Luer <jake@alogicalparadox.com>
 * MIT Licensed
 */

(function () {


    // The active `socket`
    var socket;


    // Also keep track of where it came from
    var socketSrc;


    // Used to simplify app-level connection logic-- i.e. so you don't
    // have to wait for the socket to be connected to start trying to
    // synchronize data.
    var requestQueue = [];


    // A `setTimeout` that, if necessary, is used to check if the socket
    // is ready yet (polls).
    var socketTimer;


    /**
     * _acquireSocket()
     *
     * Grab hold of our active socket object, set it on `socket` closure variable above.
     * (if your connected socket exists on a non-standard variable, change here)
     *
     * @api private
     */
    var _acquireSocket = function () {
        var oldSocket = socket;

        if (Backbone.socket) {
            socket = Backbone.socket.socket;
            socketSrc = '`Backbone.socket`';
        } else if (window.socket) {
            socket = window.socket;
            socketSrc = '`window.socket`';
        }

        // The first time a socket is acquired, bind comet listener
        if (_socketReady() && oldSocket !== socket) _bindCometListener();
    };


    /**
     * Checks if the socket is ready- if so, runs the request queue.
     * If not, sets the timer again.
     */
    var _keepTryingToRunRequestQueue = function () {
        clearTimeout(socketTimer);

        _acquireSocket();

        if (_socketReady()) {

            // Run the request queue
            _.each(requestQueue, function (request) {
                Backbone.sails.request.apply(this, request);
            });
        }
        else {

            // Reset the timer
            socketTimer = setTimeout(_keepTryingToRunRequestQueue, 250);

            // TODO:
            // After a configurable period of time, if the socket has still not connected,
            // throw an error, since the `socket` might be improperly configured.

            // throw new Error(
            // 	'\n' +
            // 	'Backbone is trying to communicate with the Sails server using '+ socketSrc +',\n'+
            // 	'but its `connected` property is still set to false.\n' +
            // 	'But maybe Socket.io just hasn\'t finished connecting yet?\n' +
            // 	'\n' +
            // 	'You might check to be sure you\'re waiting for `socket.on(\'connect\')`\n' +
            // 	'before using sync methods on your Backbone models and collections.'
            // );
        }
    };

    /**
     * Returns whether the socket is connected.
     */
    var _socketReady = function () {
        return socket && socket.socket && socket.socket.connected;
    };


    // Set up `async.until`-esque mechanism which will attempt to acquire a socket.
    var attempts = 0,
        maxAttempts = 3,
        interval = 1500,
        initialInterval = 250;


    var _attemptToAcquireSocket = function () {
        if (socket) return;
        attempts++;
        _acquireSocket();
        if (attempts >= maxAttempts) return;
        setTimeout(_attemptToAcquireSocket, interval);
    };


    // Attempt to acquire the socket more quickly the first time,
    // in case the user is on a fast connection and it's available.
    setTimeout(_attemptToAcquireSocket, initialInterval);


    /**
     * Backbone.on('comet', ...)
     *
     * Since Backbone is already a listener (extends Backbone.Events)
     * all we have to do is trigger the event on the Backbone global when
     * we receive a new message from the server.
     *
     * I realize this doesn't do a whole lot right now-- that's ok.
     * Let's start light and layer on additional functionality carefully.
     */
    var _bindCometListener = function socketAcquiredForFirstTime() {
        socket.on('message', function cometMessageReceived(message) {
            Backbone.trigger('comet', message);
        });
    };


    /**
     * # Backbone.sync
     *
     * Replaces default Backbone.sync function with socket.io transport
     *
     * @param {String} method
     * @param {Backbone.Model|Backbone.Collection} model
     * @param {Object} options
     *
     * @name sync
     */
    Backbone.sync = function (method, model, options) {

        // Clone options to avoid smashing anything unexpected
        options = _.extend({}, options);


        // Get the actual URL (call `.url()` if it's a function)
        var url;
        if (options.url) {
            url = _.result(options, 'url');
        }
        else if (model.url) {
            url = _.result(model, 'url');
        }
        // Throw an error when a URL is needed, and none is supplied.
        // Copied from backbone.js#1558
        else throw new Error('A "url" property or function must be specified');


        // Build parameters to send to the server
        var params = {};

        if (!options.data && model) {
            params = options.attrs || model.toJSON(options) || {};
        }

        if (options.patch === true && _.isObject(options.data) && options.data.id === null && model) {
            params.id = model.id;
        }

        if (_.isObject(options.data)) {
            _(params).extend(options.data);
        }


        // Map Backbone's concept of CRUD methods to HTTP verbs
        var verb;
        switch (method) {
            case 'create':
                verb = 'post';
                break;
            case 'read':
                verb = 'get';
                break;
            case 'update':
                verb = 'put';
                break;
            default:
                verb = method;
        }

        var promise = Backbone.sails.request(url, verb, params);

        promise.done(options.success    || function () {});
        promise.always(options.complete || function () {});
        // Trigger an invalid event on the model if sails returns an
        // E_VALIDATION error.
        promise.fail(function (body, response) {
            if (typeof body === 'object' && body.error === 'E_VALIDATION') {
                model.trigger('invalid', model, body.invalidAttributes, response);
            } else if (options.error) {
                options.error(body, response);
            }
        });

        model.trigger('request', model, promise, options);

        return promise;
    };

    Backbone.sails = _.extend({}, Backbone.Events);

    /**
     * #Backbone.sails.error
     *
     * Handles responses from sails API, triggering global events we can
     * listen to.
     *
     * @param {string|{}} body
     * @param {JWR} jwr
     */
    Backbone.sails.processError = function (body, jwr) {
        Backbone.sails.trigger('error', body, jwr);
        Backbone.sails.trigger('errorCode' + jwr.statusCode, body, jwr);
    };

    /**
     * #Backbone.sails.request
     *
     * Runs an HTTPish request over the sails socket.
     *
     * @param {string} url
     * @param {string} verb
     * @param {object=} data
     * @param {object} options
     * @returns {$.Deferred}
     */
    Backbone.sails.request = function (url, verb, data, options) {

        options = options || {};

        // If a promise hasn't already been made, create one. If we're getting
        // input from Backbone.sync or we're retrying a queued connection,
        // this will already have been made and given to the requester.
        options.promise = options.promise || new $.Deferred();


        // If socket is not defined yet, try to grab it again.
        _acquireSocket();

        // Ensures the socket is connected and able to communicate w/ the server.
        if (!_socketReady()) {

            // If the socket is not connected, the request is queued
            // (so it can be replayed when the socket comes online.)
            requestQueue.push([url, verb, data, options]);

            // If we haven't already, start polling the socket to see if it's ready
            _keepTryingToRunRequestQueue();

            return options.promise;
        }

        // We're ready to make a socket request! Default the data and bind
        // our error listener.
        if (options.processError !== false) {
            options.promise.fail(Backbone.sails.processError);
        }
        data = data || {};

        socket.request(url, data, function serverResponded(body, jwr) {
            var isSuccess = jwr.statusCode >= 200 && jwr.statusCode < 300 || jwr.statusCode === 304;

            options.promise[isSuccess ? 'resolveWith' : 'rejectWith'](this, arguments);
        }, verb);

        return options.promise;
    };

})();
