function ab2str(buf) {
	return RocketChat.signalUtils.toString(buf);
}

function str2ab(str) {
	return RocketChat.signalUtils.toArrayBuffer(str);
}

function saveKeyToLS(keyID, keyPair) {
	localStorage.setItem(keyID, JSON.stringify({'pubKey': ab2str(keyPair.pubKey), 'privKey': ab2str(keyPair.privKey)}));
}

function getKeyFromLS(keyID) {
	const key = localStorage.getItem(keyID);
	const keyPair = JSON.parse(key);
	keyPair.pubKey = str2ab(keyPair.pubKey);
	keyPair.privKey = str2ab(keyPair.privKey);
	return keyPair;
}

function loadKeyGlobalsFromLS() {
	RocketChat.E2EStorage.put('registrationId', parseInt(localStorage.getItem('registrationId')));
	RocketChat.E2EStorage.put('identityKey', getKeyFromLS('identityKey'));
	RocketChat.E2EStorage.storePreKey(RocketChat.E2EStorage.get('registrationId'), getKeyFromLS('preKey'));
	RocketChat.E2EStorage.storeSignedPreKey(RocketChat.E2EStorage.get('registrationId'), getKeyFromLS('signedPreKey'));
	RocketChat.E2EStorage.put(`signedPreKeySignature${ RocketChat.E2EStorage.get('registrationId') }`, str2ab(localStorage.getItem('signedPreKeySignature')));

	Meteor.call('addKeyToChain', {
		'identityKey': ab2str(RocketChat.E2EStorage.get('identityKey').pubKey),
		'preKey': ab2str(RocketChat.E2EStorage.loadPreKey(RocketChat.E2EStorage.get('registrationId')).pubKey),
		'signedPreKey': ab2str(RocketChat.E2EStorage.loadSignedPreKey(RocketChat.E2EStorage.get('registrationId')).pubKey),
		'signedPreKeySignature': ab2str(RocketChat.E2EStorage.get(`signedPreKeySignature${ RocketChat.E2EStorage.get('registrationId') }`)),
		'registrationId': RocketChat.E2EStorage.get('registrationId')
	});
}

class E2E {
	constructor() {
		this.enabled = new ReactiveVar(false);
		this.instancesByRoomId = {};
	}

	isEnabled() {
		return this.enabled.get();
	}

	getInstanceByRoomId(roomId) {
		if (!this.enabled.get()) {
			return;
		}

		if (this.instancesByRoomId[roomId]) {
			return this.instancesByRoomId[roomId];
		}

		const subscription = RocketChat.models.Subscriptions.findOne({
			rid: roomId
		});

		if (!subscription || subscription.t !== 'd') {
			return;
		}

		this.instancesByRoomId[roomId] = new RocketChat.E2E.Room(Meteor.userId(), roomId);
		return this.instancesByRoomId[roomId];
	}

	startClient() {
		// Meteor.call("emptyKeychain");
		// localStorage.clear();
		// RocketChat.E2EStorage.store = {}
		if (localStorage.getItem('registrationId') == null) {		// This is a new device.
			const KeyHelper = libsignal.KeyHelper;
			const registrationId = KeyHelper.generateRegistrationId();
			localStorage.setItem('registrationId', registrationId);

			KeyHelper.generateIdentityKeyPair().then(function(identityKeyPair) {
				saveKeyToLS('identityKey', identityKeyPair);

				KeyHelper.generatePreKey(registrationId).then(function(preKey) {
					saveKeyToLS('preKey', preKey.keyPair);
				});

				KeyHelper.generateSignedPreKey(getKeyFromLS('identityKey'), registrationId).then(function(signedPreKey) {
					saveKeyToLS('signedPreKey', signedPreKey.keyPair);
					localStorage.setItem('signedPreKeySignature', ab2str(signedPreKey.signature));

					loadKeyGlobalsFromLS();
				});
			});
		}		else {
			loadKeyGlobalsFromLS();
		}
	}
}

RocketChat.E2E = new E2E();

Meteor.startup(function() {
	RocketChat.E2E.startClient();
	Tracker.autorun(function() {
		if (Meteor.userId()) {
			RocketChat.Notifications.onUser('e2e', (type, data) => {
				if (!data.roomId || !data.userId || data.userId === Meteor.userId()) {
					return;
				} else {
					RocketChat.E2E.getInstanceByRoomId(data.roomId).onUserStream(type, data);
				}
			});
		}
	});

	RocketChat.promises.add('onClientBeforeSendMessage', function(message) {
		if (message.rid && RocketChat.E2E.getInstanceByRoomId(message.rid) && RocketChat.E2E.getInstanceByRoomId(message.rid).established.get()) {
			return RocketChat.E2E.getInstanceByRoomId(message.rid).encrypt(message)
				.then((msg) => {
					message.msg = msg;
					message.t = 'e2e';
					console.log(message);
					return message;
				});
		} else {
			return Promise.resolve(message);
		}
	}, RocketChat.promises.priority.HIGH);

	RocketChat.promises.add('onClientMessageReceived', function(message) {
		console.log(message);
		const e2eRoom = RocketChat.E2E.getInstanceByRoomId(message.rid);
		const peerRegistrationId = e2eRoom.peerRegistrationId;
		const existingSession = RocketChat.E2EStorage.sessionExists(peerRegistrationId);
		if (message.rid && RocketChat.E2E.getInstanceByRoomId(message.rid) && message.t == 'e2e') { //&& RocketChat.E2E.getInstanceByRoomId(message.rid).established.get()) {
			if (message.notification) {
				message.msg = t('Encrypted_message');
				return Promise.resolve(message);
			} else {
				const otrRoom = RocketChat.E2E.getInstanceByRoomId(message.rid);
				console.log(message);

				console.log(`session exists: ${ existingSession }`);

				if (existingSession) {
					return otrRoom.decrypt(message.msg)
					.then((data) => {
						console.log(data);
						const {_id, text, ack} = data;
						message._id = _id;
						message.msg = text;

						if (data.ts) {
							message.ts = data.ts;
						}
						return message;
						// if (message.otrAck) {
						// 	return otrRoom.decrypt(message.otrAck)
						// 		.then((data) => {
						// 			if (ack === data.text) {
						// 				message.t = 'otr-ack';
						// 			}
						// 			return message;
						// 		});
						// } else if (data.userId !== Meteor.userId()) {
						// 	return otrRoom.encryptText(ack)
						// 		.then((ack) => {
						// 			Meteor.call('updateOTRAck', message._id, ack);
						// 			return message;
						// 		});
						// } else {
						// 	return message;
						// }
					});
				}				else {
					return e2eRoom.decryptInitial(message.msg)
					.then((data) => {
						console.log(data);
						const {_id, text, ack} = data;
						message._id = _id;
						message.msg = text;

						if (data.ts) {
							message.ts = data.ts;
						}
						return message;
						// if (message.otrAck) {
						// 	return otrRoom.decrypt(message.otrAck)
						// 		.then((data) => {
						// 			if (ack === data.text) {
						// 				message.t = 'otr-ack';
						// 			}
						// 			return message;
						// 		});
						// } else if (data.userId !== Meteor.userId()) {
						// 	return otrRoom.encryptText(ack)
						// 		.then((ack) => {
						// 			Meteor.call('updateOTRAck', message._id, ack);
						// 			return message;
						// 		});
						// } else {
						// 	return message;
						// }
					});
				}

			}
		} else {
			if (message.t === 'otr') {
				message.msg = '';
			}
			return Promise.resolve(message);
		}
	}, RocketChat.promises.priority.HIGH);
});
