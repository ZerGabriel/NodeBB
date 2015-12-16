'use strict';

var async = require('async');

var meta = require('../meta');
var plugins = require('../plugins');
var db = require('../database');


module.exports = function(Messaging) {


	Messaging.newMessage = function(uid, toUids, content, timestamp, callback) {
		var roomId;
		async.waterfall([
			function (next) {
				Messaging.checkContent(content, next);
			},
			function (next) {
				db.incrObjectField('global', 'nextChatRoomId', next);
			},
			function (_roomId, next) {
				roomId = _roomId;
				db.sortedSetAdd('chat:room:' + roomId + ':uids', timestamp, uid, next);
			},
			function (next) {
				Messaging.addUsersToRoom(uid, toUids, roomId, next);
			},
			function (next) {
				Messaging.sendMessage(uid, roomId, content, timestamp, next);
			}
		], callback);
	};

	Messaging.sendMessage = function(uid, roomId, content, timestamp, callback) {
		async.waterfall([
			function (next) {
				Messaging.checkContent(content, next);
			},
			function (next) {
				Messaging.isUserInRoom(uid, roomId, next);
			},
			function (inRoom, next) {
				if (!inRoom) {
					return next(new Error('[[error:not-allowed]]'));
				}
				Messaging.addMessage(uid, roomId, content, timestamp, next);
			}
		], callback);
	};

	Messaging.checkContent = function(content, callback) {
		if (!content) {
			return callback(new Error('[[error:invalid-chat-message]]'));
		}

		if (content.length > (meta.config.maximumChatMessageLength || 1000)) {
			return callback(new Error('[[error:chat-message-too-long]]'));
		}
	};

	Messaging.addMessage = function(fromuid, roomId, content, timestamp, callback) {
		var mid;
		var message;
		async.waterfall([
			function (next) {
				Messaging.checkContent(content, next);
			},
			function (next) {
				db.incrObjectField('global', 'nextMid', next);
			},
			function (_mid, next) {
				mid = _mid;
				message = {
					content: content,
					timestamp: timestamp,
					fromuid: fromuid
				};

				plugins.fireHook('filter:messaging.save', message, next);
			},
			function (message, next) {
				db.setObject('message:' + mid, message, next);
			},
			function (next) {
				db.getSortedSetRange('chat:room:' + roomId + ':uids', 0, -1, next);
			},
			function (uids, next) {
				async.parallel([
					async.apply(Messaging.updateChatTime, roomId, uids, timestamp),
					async.apply(Messaging.addMessageToUsers, roomId, uids, mid, timestamp),
					async.apply(Messaging.markRead, fromuid, roomId),
					async.apply(Messaging.markUnread, uids, roomId)
				], next);
			},
			function (results, next) {
				async.parallel({
					messages: async.apply(Messaging.getMessagesData, [mid], fromuid, roomId, true),
					isNewSet: async.apply(Messaging.isNewSet, fromuid, roomId, mid)
				}, next);
			},
			function (results, next) {
				if (!results.messages || !results.messages[0]) {
					return next(null, null);
				}

				results.messages[0].newSet = results.isNewSet;
				results.messages[0].mid = mid;
				next(null, results.messages[0]);
			}
		], callback);
	};

	Messaging.updateChatTime = function(roomId, uids, timestamp, callback) {
		if (!uids.length) {
			return callback();
		}
		var keys = uids.map(function(uid) {
			return 'uid:' + uid + ':chat:rooms';
		});
		db.sortedSetsAdd(keys, timestamp, roomId, callback);
	};

	Messaging.addMessageToUsers = function(roomId, uids, mid, timestamp, callback) {
		if (!uids.length) {
			return callback();
		}
		var keys = uids.map(function(uid) {
			return 'uid:' + uid + ':chat:room:' + roomId + ':mids';
		});
		db.sortedSetsAdd(keys, timestamp, mid, callback);
	};
};