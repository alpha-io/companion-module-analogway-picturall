var tcp = require('../../tcp');
var instance_skel = require('../../instance_skel');
var debug;
var log;

function instance(system, id, config) {
	var self = this;

	this.numPlaybacks = 8;
	this.firmwareVersion = "0";
	this.numOutputs = 0;
	this.numInputs = 0;
	this.modelname = '';
	this.cuestacks = [0,0,0,0,0,0,0,0,0];
	this.cuestackIDs = [0,0,0,0,0,0,0,0,0];
	this.laststackinfo = 0;
	this.laststackinfoTimestamp = 0;

	// super-constructor
	instance_skel.apply(this, arguments);

	self.actions(); // export actions

	return self;
}


instance.prototype.init = function() {
	var self = this;

	debug = self.debug;
	log = self.log;

	self.init_variables();
	self.init_presets();
	self.init_feedbacks();
	self.init_tcp();

};

instance.prototype.init_tcp = function() {
	var self = this;
	var receivebuffer = '';

	if (self.socket !== undefined) {
		self.socket.destroy();
	}

	if (self.config.host) {
		self.socket = new tcp(self.config.host, 11000);

		self.socket.on('status_change', function (status, message) {
			self.status(status, message);
		});

		self.socket.on('error', function (err) {
			debug("Network error", err);
			self.log('error',"Network error: " + err.message);
		});

		self.socket.on('connect', function () {
			debug("Connected");
			self.sendcmd("wait_startup");
			self.status(this.STATUS_UNKNOWN, 'Connected, waiting for server ready');
			// we don't know if the application is ready to receive commands
		});

		// separate buffered stream into lines with responses
		self.socket.on('data', function (chunk) {
			var i = 0, line = '', offset = 0;
			receivebuffer += chunk;
			while ( (i = receivebuffer.indexOf('\n', offset)) !== -1) {
				line = receivebuffer.substr(offset, i - offset);
				offset = i + 1;
				self.socket.emit('receiveline', line.toString());
			}
			receivebuffer = receivebuffer.substr(offset);
		});

		self.socket.on('receiveline', function (line) {
			debug("Received line from Picturall:", line);

			if (line.match(/Show running!/)) {
				// now it is ready
				self.status(this.STATE_OK);
				self.sendcmd("config");
				for(var i=1; i<9; i++) {
					self.sendcmd('ctrl_status stack'+i);
				}
			}

			if (line.match(/config->version=[\d\.]+/)) {
				this.firmwareVersion = line.match(/config->version=([\d\.]+)/)[1];
				self.log('info', self.config.label +" software version is "+ this.firmwareVersion);
				self.setVariable('software_version', this.firmwareVersion);
			}

			if (line.match(/Control status for stack\d+:/)) {
				// it seems we are soon getting info about a playback
				this.laststackinfo = parseInt(line.match(/Control status for stack(\d+)/)[1]);
				this.laststackinfoTimestamp = parseInt('' + line.match(/(\d+)\.\d\d\d\d/)[1] + line.match(/\.(\d\d\d\d)/)[1]);
			}

			if (line.match(/select cue_stack=\d+,major=\d+,minor=\d+/)) {
				// here is the info about a playback, but for which one?
				var timestamp = parseInt('' + line.match(/(\d+)\.\d\d\d\d/)[1] + line.match(/\.(\d\d\d\d)/)[1]);
				if (Math.abs(timestamp - this.laststackinfoTimestamp) < 20) { // only accept info if last header is not older than 20ms
					var cs = line.match(/cue_stack=(\d+),/)[1];
					self.setVariable('playback' +this.laststackinfo+ '_cuestack', cs);
					self.setVariable('playback' +this.laststackinfo+ '_cue', line.match(/major=(\d+),/)[1] + '.' + line.match(/minor=(\d+)/)[1]);
					self.cuestacks[this.laststackinfo] = cs;
					self.checkFeedbacks('playback_empty');
				}
			}

			if (line.match(/\[stack[1-8]\]:\s+select\s+\(current\):\s+stack:\s+\d+\s+\(\d+\),\s+cue:\s+\d+\.\d+\s+\(\d+\.\d+\)/)) {
				//something changed in the playbacks
				var playback = line.match(/\[stack([1-8])\]:/)[1];
				self.sendcmd('ctrl_status stack'+playback);
			}

			if (line.match(/\[stack[1-8]\]:.+trigger/i)) {
				//something changed in the playbacks
				var playback = line.match(/\[stack([1-8])\]:/)[1];
				self.sendcmd('ctrl_status stack'+playback);
			}

			if (line.match(/Unknown command: ".+?"/)) {
				self.log('error',"Received error from "+ self.config.label +": "+ line.match(/Unknown command: "(.+?)"/)[1]);
			}

		});

	}
};

// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this;

	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'IP-Adress of Picturall server',
			width: 6,
			default: '192.168.2.140',
			regex: self.REGEX_IP,
			tooltip: 'Enter the IP-adress of the Picturall server you want to control. The IP of the unit can be found on the frontpanel LCD.'
		}
	]
};

// When module gets deleted
instance.prototype.destroy = function() {
	var self = this;

	if (self.socket !== undefined) {
		self.socket.destroy();
	}

	debug("destroy", self.id);;
};

instance.prototype.init_variables = function() {
	var self = this;

	// variable_set
	var variables = [
		{
			label: 'Version of the Server Software',
			name: 'software_version'
		}];

	for (var pb = 1; pb <= this.numPlaybacks; pb++) {
		variables.push(
			{
				label: 'Cue Stack in Playback ' + pb,
				name: 'playback' + pb + '_cuestack'
			}, {
				label: 'Active Cue in Playback ' + pb,
				name: 'playback' + pb + '_cue'
			}
		);
	}

	self.setVariableDefinitions(variables);
	self.setVariable('software_version', 'unknown');

	for (var pb = 1; pb <= this.numPlaybacks; pb++) {
		self.setVariable('playback' +pb+ '_cuestack', 'unknown');
		self.setVariable('playback' +pb+ '_cue', 'unknown');
	}

};

instance.prototype.actions = function(system) {
	var self = this;
	self.system.emit('instance_actions', self.id, {

		'run_cue': {
			label: 'Run Cue',
			options: [{
				type: 'textinput',
				label: 'Cue',
				id: 'cue',
				default: '1',
				regex: '/^0*[1-9][0-9]*$/'
			}]
		},

		'playback_go': {
			label: 'Playback Go',
			options: [{
				type: 'textinput',
				label: 'Playback to go',
				id: 'playback',
				default: '1',
				regex: '/^0*[1-8]$/'
			}]
		},

		'playback_goto': {
			label: 'Playback Goto',
			options: [{
				type: 'textinput',
				label: 'Playback to goto',
				id: 'playback',
				default: '1',
				regex: '/^0*[1-8]$/'
			},{
				type: 'textinput',
				label: 'Cue to go',
				id: 'cue',
				default: '1.0',
				regex: '/^0*[1-9][0-9]*(\.[0-9]+)?$/'
			}]
		},

		'playback_selectcuestack': {
			label: 'Select Cuestack into Playback',
			options: [{
				type: 'textinput',
				label: 'Cuestack',
				id: 'cuestack',
				default: '1',
				regex: '/^0*[1-9][0-9]*$/'
			},{
				type: 'textinput',
				label: 'Playback to select into',
				id: 'playback',
				default: '1',
				regex: '/^0*[1-8]$/'
			}]
		},

		'playback_release': {
			label: 'Playback Release',
			options: [{
				type: 'textinput',
				label: 'Playback to release',
				id: 'playback',
				default: '1',
				regex: '/^0*[1-8]$/'
			}]
		},

		'layer_playback': {
			label: 'Layer Playback control',
			options: [{
				type: 'textinput',
				label: 'Layer',
				id: 'layer',
				regex: '/^0*[1-9][0-9]*$/'
			},{
				type: 'dropdown',
				label: 'Play command',
				id: 'playstate',
				default: '0',
				choices: [
					{ id: '0', label: 'Play' },
					{ id: '5', label: 'Pause' },
					{ id: '6', label: 'Stop' }
				]
			}]
		},

		'layer_playback_seek': {
			label: 'Layer Playback Seek',
			options: [{
				type: 'textinput',
				label: 'Layer',
				id: 'layer',
				regex: '/^0*[1-9][0-9]*$/'
			},{
				type: 'dropdown',
				label: 'Seek command',
				id: 'seek',
				default: '0',
				choices: [
					{ id: '0', label: 'Goto Inpoint' },
					{ id: '1', label: 'Goto Outpoint' },
					{ id: '5', label: 'Previous Frame' },
					{ id: '6', label: 'Next Frame' }
				]
			}]
		},

		'layer_playback_endaction': {
			label: 'Set Layer Media End Action',
			options: [{
				type: 'textinput',
				label: 'Layer',
				id: 'layer',
				regex: '/^0*[1-9][0-9]*$/'
			},{
				type: 'dropdown',
				label: 'End Action',
				id: 'endaction',
				default: '0',
				choices: [
					{ id: '0', label: 'Default' },
					{ id: '4', label: 'Loop' },
					{ id: '10', label: 'Loop Collection' },
					{ id: '11', label: 'Random' },
					{ id: '1', label: 'Play Next' },
					{ id: '3', label: 'Pause' },
					{ id: '2', label: 'Stop' }
				]
			}]
		},


		'sendcustomcommand': {
			label: 'Send custom command',
			options: [{
				type: 'textinput',
				label: 'Command',
				id: 'command',
				default: '',
				tooltip: "Enter any command you like in plain ASCII. Beware of correct syntax, you mustn't enter the linefeed at the end of the command.",
				regex: '/^.+$/i'
			}]
		}
	});
};

instance.prototype.action = function(action) {
	var self = this;
	var cmd = '';

	switch(action.action) {

		case 'run_cue':
			cmd = 'set cue1 playback cue=' + parseInt(action.options.cue).toString();
			break;

		case 'playback_go':
			cmd = 'set stack'+ parseInt(action.options.playback).toString() +' control command=1';
			break;

		case 'playback_goto':
			cmd = 'set stack'+ parseInt(action.options.playback).toString() + ' select major=' + parseInt(action.options.cue).toString();
			if (action.options.cue.match(/\./)) {
				cmd += ',minor=' + parseInt(action.options.cue.match(/\.(\d+)/)[1]).toString();
			}
			break;

		case 'playback_selectcuestack':
			cmd = 'set stack'+ parseInt(action.options.playback).toString() +' select cue_stack=' + parseInt(action.options.cuestack).toString();
			break;

		case 'playback_release':
			cmd = 'set stack'+ parseInt(action.options.playback).toString() +' select cue_stack=0';
			break;

		case 'layer_playback':
			cmd = 'set source' + parseInt(action.options.layer).toString() + ' control play_state_req=' + parseInt(action.options.playstate).toString();
			break;

		case 'layer_playback_seek':
			switch(action.options.seek) {
				case '0':
					cmd = 'set source' + parseInt(action.options.layer).toString() + ' control seek=0.0';
					break;
				case '1':
					cmd = 'set source' + parseInt(action.options.layer).toString() + ' control seek=1.0';
					break;
				case '5':
					cmd = 'set source' + parseInt(action.options.layer).toString() + ' tools step=-1';
					break;
				case '6':
					cmd = 'set source' + parseInt(action.options.layer).toString() + ' tools step=1';
					break;

			}
			break;

		case 'layer_playback_endaction':
			cmd = 'set source' + parseInt(action.options.layer).toString() + ' control media_end_action=' + parseInt(action.options.endaction).toString();
			break;

		case 'sendcustomcommand':
			cmd = action.options.command;
			break;

		default:
			break;
	}
	self.sendcmd(cmd);
};


instance.prototype.sendcmd = function(cmd) {
	var self = this;
	cmd +="\n";

	if (cmd !== undefined) {

		if (self.socket === undefined) {
			self.init_tcp();
		}

		// TODO: remove this when issue #71 is fixed
		if (self.socket !== undefined && self.socket.host != self.config.host) {
			self.init_tcp();
		}

		debug('sending tcp',cmd,"to",self.config.host);

		if (self.socket !== undefined && self.socket.connected) {
			self.socket.send(cmd);
		} else {
			debug('Socket not connected :(');
		}

	}
};

instance.prototype.init_feedbacks = function() {
	var self = this;

	// feedbacks
	var feedbacks = {};

	feedbacks['playback_empty'] = {
		label: 'Change background with cuestack',
		description: 'If the specified playback has a cuestack (is not empty), change colors of the bank',
		options: [
			{
				type: 'textinput',
				label: 'Playback',
				id: 'playback',
				default: '1',
				regex: '/^0*[1-9][0-9]*$/'
			},{
				type: 'colorpicker',
				label: 'Not empty foreground color',
				id: 'goodfg',
				default: self.rgb(0,0,0)
			},{
				type: 'colorpicker',
				label: 'Not enpty background color',
				id: 'goodbg',
				default: self.rgb(255,0,0)
			},{
				type: 'colorpicker',
				label: 'Empty foreground color',
				id: 'badfg',
				default: self.rgb(0,0,0)
			},{
				type: 'colorpicker',
				label: 'Empty background color',
				id: 'badbg',
				default: self.rgb(127,0,0)
			}
		]
	};

	self.setFeedbackDefinitions(feedbacks);
};

instance.prototype.getCuestack = function(pb) {
	return this.cuestacks[pb];
};

instance.prototype.feedback = function(feedback, bank) {
	var out  = {};
	var opt = feedback.options;

	if (feedback.type == 'playback_empty') {
		if (this.getCuestack(opt.playback) >= 1) {
			out = { color: opt.goodfg, bgcolor: opt.goodbg };
		} else {
			out = { color: opt.badfg, bgcolor: opt.badbg };
		}
	}

	return out;
};


instance.prototype.init_presets = function () {
	var self = this;
	var presets = [];

	for (var pb = 1; pb <= this.numPlaybacks; pb++) {
		presets.push({
			category: 'Playbacks',
			label: 'Go button for playback ' + pb,
			bank: {
				style: 'text',
				text: 'GO ' + pb,
				size: 'auto',
				color: 0,
				bgcolor: self.rgb(255, 0, 0)
			},
			actions: [
				{
					action: 'playback_go',
					options: {
						playback: pb
					}
				}
			]
		},{
			category: 'Playbacks with Cuestatus',
			label: 'Go button for playback ' + pb,
			bank: {
				style: 'text',
				text: 'GO ' + pb + '\\n$(Picturall:playback' + pb + '_cuestack) : $(Picturall:playback' + pb + '_cue)',
				size: 'auto',
				color: 0,
				bgcolor: self.rgb(255, 0, 0)
			},
			actions: [
				{
					action: 'playback_go',
					options: {
						playback: pb
					}
				}
			],
			feedbacks: [
				{
					type: 'playback_empty',
					options: {
						playback: pb,
						goodbg: self.rgb(255, 0, 0),
						goodfg: self.rgb(0, 0, 0),
						badbg: self.rgb(127, 0, 0),
						badfg: self.rgb(0, 0, 0)
					}
				}
			]
		});

	}

	this.setPresetDefinitions(presets);
};

instance_skel.extendedBy(instance);
exports = module.exports = instance;
