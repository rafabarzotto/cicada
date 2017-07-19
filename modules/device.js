'use strict'
const EventEmitter = require('events').EventEmitter;
const async = require('async');
const db = require('./db');
const mixin = require('./mixin');
const protocols = require('./protocols');
const nmap = require('./nmap');

let timers = {};

Object.assign(Device, mixin.get('device'), {cache: cacheAll, events: new EventEmitter(), getValue, getIpList, updateLatencies, getHistoryByTag, getTagList});

function cacheAll (callback) {
	async.series([
			(callback) => db.all('select * from devices', callback),
			(callback) => db.all('select * from varbinds', callback),
		], 
		function(err, results) {
			if (err)
				return callback(err);

			results[1].forEach((r) => (new Varbind(r)).cache());
			results[0].forEach((r) => (new Device()).setAttributes(r).cache().updateVarbindList().updateStatus());

			async.eachSeries(Device.getList(), db.checkHistoryTable, callback);
		}
	)
}

function getIpList (is_pinged) {
	return Device.getList()
		.map((d) => !is_pinged || is_pinged && d.is_pinged ? d.ip : '')
		.map((ip) => (ip + '').trim())
		.filter((ip) => !!ip)
		.filter((e, idx, r) => r.indexOf(e) == idx); // unique
}

function updateLatencies (data, callback) {
	if (!data || !data.length)
		return callback();

	let odata = {};
	data.forEach((row) => odata[row.ip] = row);

	let columns = ['time'];
	let values = [new Date().getTime()];
	Device.getList().filter((d) => !!d.is_pinged).forEach(function(d, i) {
		let res = odata[d.ip] || data[i] && data[i].for == d.ip && data[i];
		if (!res || !d.is_pinged)
			return;

		d.alive = res.alive;

		columns.push('device' + d.id);
		let latency = res.latency;
		values.push(isNaN(latency) ? 'null' : latency);

		if (!d.is_status) {
			let prev_prev_status = d.prev_status;
			d.prev_status = d.status;
			d.status = res.alive ? 1 : (device.force_status_to || 3);
			Device.events.emit('status-updated', d);
			if (prev_prev_status != undefined && d.prev_status != d.status)
				Device.events.emit('status-changed', d, 'ping');
		}
	})

	db.run(`insert into history.latencies ("${columns.join('","')}") values (${values.join(',')})`, callback);
}

// Return object: key is tags of devices, values is array of varbind tags
function getTagList () {
	let tags = {All: []};
	let device_list = Device.getList();
	device_list.forEach((d) => d.is_pinged && d.tag_list.forEach((tag) => tags[tag] = ['latency']));
	device_list.forEach(function(d) {
		d.tag_list.forEach(function(tag) {
			if (!tags[tag])
				tags[tag] = [];

			d.varbind_list.filter((v) => v.value_type == 'number').forEach((v) => tags[tag].push.apply(tags[tag], v.tag_list || []));
		})

		if (d.tag_list.length == 0)
			d.varbind_list.filter((v) => v.value_type == 'number').forEach((v) => tags.All.push.apply(tags.All, v.tag_list || []));
	});

	for (let tag in tags)
		if (tags[tag].length == 0)
			delete tags[tag];	

	for (let tag in tags)
		tags.All.push.apply(tags.All, tags[tag]);

	for (let tag in tags) 
		tags[tag] = tags[tag].filter((t, idx, tags) => tags.indexOf(t) == idx);
	
	return tags;
}

function getHistoryByTag(tag, device_tags, period, callback) {
	let device_list = Device.getList();
	let device_tag_list = (device_tags || '').split(';');

	if (device_tag_list.length && device_tag_list.indexOf('All') == -1) {
		device_list = device_list.filter((d) => device_tag_list.some(function (tag) {
			let re = new RegExp('\\b' + tag + '\\b');
			return re.test(d.tag_list.join(' '))
		}));
	}

	if (!device_list.length)	
		return callback(new Error('Device list is empty')); 

	if (tag == 'latency') {
		db.all(`select "time", ${device_list.map((d) => 'device' + d.id).join(', ')} from history.latencies where time between ? and ? order by "time"`, period, function (err, rows) {
			if (err)
				return callback(err);
	
			let res = {
				columns: ['time'].concat(device_list.map((d) => d.name)),
				rows: rows.map((row) => [row.time].concat(device_list.map((d) => row['device' + d.id])))
			}
			callback(null, res);
		});
		return;
	}

	function getHistory(device, callback) {
		let varbind_list = device.varbind_list.filter((v) => v.tag_list.indexOf(tag) != -1 && v.value_type == 'number');
		if (varbind_list.length == 0)
			return callback(null, null);

		db.all(`select "time", ${varbind_list.map((v) => 'varbind' + v.id + ', varbind' + v.id + '_status').join(', ')} from history.device${device.id} where time between ? and ? order by "time"`, period, function (err, rows) {
			if (err)
				return callback(err);
	
			let res = {
				ids: varbind_list.map((v) => v.id),
				columns: varbind_list.map((v) => device.name + '/' + v.name),
				rows: rows.map((row) => [row.time].concat(varbind_list.map((v) => row['varbind' + v.id]))),
				alerts: getHistoryAlerts(varbind_list, rows)
			}
			callback(null, res);
		});
	}

	async.mapSeries(device_list, getHistory, function(err, results) {
		if (err)
			return callback(err);

		let ids = [];
		results.forEach((res) => res ? ids.push.apply(ids, res.ids) : null);

		let columns = ['time'];
		results.forEach((res) => res ? columns.push.apply(columns, res.columns) : null);
		
		let alerts = {};
		results.forEach((res) => Object.assign(alerts, res && res.alerts || {}));

		let times = {};
		results.forEach(function (res) {
			if (!res)
				return;

			let idx = res.columns.map((c) => columns.indexOf(c));
			res.rows.forEach(function(row) {
				let time = row[0];
				if (!times[time]) {
					times[time] = new Array(columns.length);	
					times[time][0] = time;
				}

				for (let i = 1; i < row.length; i++) 
					times[time][idx[i - 1]] = parseFloat(row[i]) || null;
			})
		})

		let rows = [];
		for (let time in times)
			rows.push(times[time]);

		callback(null, {ids, columns, rows, alerts});
	})	
}

function getValue(opts, callback) {
	if (!opts.protocol || !protocols[opts.protocol])
		return callback(new Error('Unsupported protocol'));

	if (!opts.address)	
		return callback(new Error('Address is empty'));

	protocols[opts.protocol].getValues(opts.protocol_params, [opts.address], function(err, res) {
		callback(null, (err) ? 'ERR: ' + err.message : applyDivider(res[0].value, opts.divider));
	})
}

function Device() {
	this.__type__ = 'device';
	this.varbind_list = [];
	this.status = 0;
	Object.defineProperty(this, 'is_status', {get: () => this.varbind_list.some((v) => v.is_status)});
}

Device.prototype.setAttributes = function (data) {
	if (this.template)
		delete data.template;

	Object.assign(this, data);
	if (this.id) 
		this.id = parseInt(this.id);

	this.timeout = parseInt(this.timeout) || 3;

	try {
		this.protocols = JSON.parse(data.json_protocols);
		for (let protocol in this.protocols)
			this.protocols[protocol].timeout = this.timeout;
	} catch (err) {
		this.json_protocols = '{}';
		this.protocols = {};
		console.error(__filename, err);
	}

	if (!this.json_varbind_list)
		this.json_varbind_list = '[]';

	this.tag_list = !!this.tags ? this.tags.toString().split(';').map((t) => t.trim()).filter((t, idx, tags) => tags.indexOf(t) == idx) : [];
	this.tags = this.tag_list.join(';');
	this.is_pinged = parseInt(this.is_pinged);
		
	return this;
}

Device.prototype.cache = mixin.cache;

Device.prototype.updateStatus = function () {
	this.prev_status = this.status;
	this.status = this.varbind_list.reduce((max, e) => Math.max(max, e.status || 0), 0);
	return this;
}

Device.prototype.updateVarbindList = function () {
	this.varbind_list = mixin.get('varbind').getList().filter((v) => v.device_id == this.id) || [];
	return this;
}

Device.prototype.getHistory = function (period, callback) {
	let device = this;
	let varbind_list = device.varbind_list.filter((v) => v.value_type == 'number');

	if (varbind_list.length == 0)
		return callback(null, {columns:[], rows: [], alerts: {}});
	
	let columns = ['time'];
	columns.push.apply(columns, varbind_list.map((v) => `varbind${v.id}`));

	let cols = ['time'];
	varbind_list.forEach((v) => cols.push(`varbind${v.id}`) && cols.push(`varbind${v.id}_status`));
	
	db.all(`select ${cols.join(',')} from history.device${device.id} where time between ? and ? order by "time"`, period, function (err, rows) {
		if (err)	
			return callback(err);

		let res = {
			columns: columns,
			rows: rows.map((row) => columns.map((c) => isNaN(row[c]) ? row[c] : parseFloat(row[c]))),
			alerts: getHistoryAlerts(varbind_list, rows)
		}
		callback(null, res);
	});
}

function getHistoryAlerts(varbind_list, rows) {
	let alerts = {};
	varbind_list.forEach((v) => alerts[v.id] = {});
	rows.forEach(function (row) {
		varbind_list.forEach(function (v) {
			let status = row[`varbind${v.id}_status`];
			if (status == 2 || status == 3)
				alerts[v.id][row.time] = status;
		});
	});
	return alerts;
}

Device.prototype.getChanges = function (period, callback) {
	let device = this;
	let from = period[0];
	let to = period[1];
	let ids = device.varbind_list.filter((v) => v.value_type != 'number').map((v) => v.id).join(', ');

	db.all(
		`select start_date, end_date, varbind_id, prev_value, value, status from changes.device${device.id} where varbind_id in (${ids}) and (
			start_date <= ${from} and (end_date >= ${from} or end_date is null) or 
			start_date >= ${from} and (end_date <= ${to} or end_date is null) or 
			start_date <= ${to} and (end_date >= ${to} or end_date is null))`, 
		function (err, rows) {
			if (err)
				return callback(err);
	
			let time = new Date().getTime();	
			let res = rows.map((row) => [row.start_date, row.end_date || time, row.varbind_id, row.prev_value, row.value, row.status]);
			callback(null, res);
		}
	);
}

Device.prototype.updateParent = function (callback) {
	let device = this;
	if (!device.ip) {
		device.parent_id = null;
		return callback(null, null);		
	}

	nmap.route(device.ip, function(err, ips) {
		let res;
		Device.getList().forEach(function(d) {
			let hop = ips.indexOf(d.ip);
			if (hop == -1)
				return;
	
			if (!res || res.hop < hop && device.ip != d.ip && d.is_pinged)
				res = {hop, parent: d};
		});
	
		let parent = res && res.parent || null;
		let parent_id = parent ? parent.id : null;
		db.run('update devices set parent_id = ? where id = ?', [parent_id, device.id], function (err) {
			if (err) 
				return callback(err);
	
			device.parent_id = parent_id;
			callback(null, parent);
		});
	})
}

Device.prototype.polling = function (delay) {
	let device = this;
	
	if (timers[device.id]) {
		clearTimeout(timers[device.id]);
		delete timers[device.id];
	}

	if (!device.varbind_list || device.varbind_list.length == 0)
		return;

	if (delay)
		return timers[device.id] = setTimeout(() => device.polling(), delay);

	let values = {};
	let errors = [];
	async.eachOfSeries(protocols, function(protocol, protocol_name, callback) {
			let opts = device.protocols[protocol_name];
			let varbind_list = device.varbind_list.filter((v) => v.protocol == protocol_name && !v.is_expression);
			let address_list = varbind_list.map((v) => v.address);

			if (address_list.length == 0 || !opts)
				return callback();

			opts.ip = device.ip;	
			protocol.getValues(opts, address_list, function(err, res) {
				errors.push(err);
				varbind_list.forEach((v, i) => values[v.id] = (err) ? err.message : res[i]);
				callback();
			})
		}, 
		function (err) {	
			device.varbind_list.filter((v) => !v.is_expression && values[v.id] !== undefined).forEach(function(v) {
				let value = values[v.id].value;
				let isError = values[v.id].isError;

				value = (isError) ? 'ERR: ' + value : applyDivider (value, v.divider);
				v.prev_value = v.value;
				v.value = value;
				v.updateStatus();
			});

			device.varbind_list.filter((v) => v.is_expression).forEach(function(v) {
				let value = v.calcExpressionValue();
				value = (value instanceof Error) ? 'ERR: ' + value.message : applyDivider (value, v.divider);
				v.prev_value = v.value;
				v.value = value;
				v.updateStatus();
			})

			device.varbind_list.filter((v) => v.value != v.prev_value || v.status != v.prev_status).forEach(function (v) {
				let sql = 'update varbinds set value = ?, prev_value = ? where id = ?'; 
				let params = [v.value, v.prev_value, v.id];
				db.run(sql, params, (err) => (err) ? console.log(__filename, err, {sql, params}) : null);
			});

			let time = new Date().getTime();
			Device.events.emit('values-changed', device, time);

			let isError = errors.every((e) => e instanceof Error)
			if (isError || device.is_status) {
				if (isError) {
					device.prev_status = device.status;
					device.status = device.force_status_to;
				} else {
					device.updateStatus();
				}	 

				Device.events.emit('status-updated', device);

				if (device.prev_status != device.status) {
					let reason = isError ? 
						errors.map((e) => e.message).join(';') :
						device.varbind_list.filter((v) => v.is_status && v.status == device.status).map((v) => v.name + ': ' + v.value).join(';');
					Device.events.emit('status-changed', device, reason);
				}
			} 
	
			let query_list = [];
			let params_list = [];

			// number
			let columns = ['time'];
			let params = [time];
			device.varbind_list
				.filter((v) => v.value_type == 'number' && (!!v.value || v.value === 0))
				.forEach(function(v) {
					columns.push(`varbind${v.id}`);
					params.push(`${v.value}`);

					if (!v.status)
						return;
					columns.push(`varbind${v.id}_status`);			
					params.push(`${v.status}`);
				});
			query_list.push(`insert into history.device${device.id} (${columns.join(',')}) values (${'?, '.repeat(columns.length - 1) + '?'})`);
			params_list.push(params);

			// Other types
			device.varbind_list
				.filter((v) => v.value_type != 'number' && v.prev_value != v.value)
				.forEach(function(v) {
					if (v.value_type == 'duration' && !isNaN(v.prev_value) && !isNaN(v.value) && (v.value - v.prev_value) > 0)
						return;

					query_list.push(`update changes.device${device.id} set end_date = ? where varbind_id = ? and end_date is null`);
					params_list.push([time - 1, v.id]);

					query_list.push(`insert into changes.device${device.id} (varbind_id, prev_value, value, status, start_date) values (?, ?, ?, ?, ?)`);
					params_list.push([v.id, v.value_type == 'duration' ? v.prev_value : null, v.value, v.status, time]);
				});

			async.eachOfSeries(
				query_list, 
				(query, idx, callback) => db.run(query, params_list[idx], callback), 
				(err) => (err) ? console.error(__filename, query, params_list[idx], err) : null
			);
	
			device.polling(device.period * 1000 || 60000);
		}
	) 
}

Device.prototype.delete = function (callback) {
	let device = this;
	async.series([
			(callback) => db.run('begin transaction', callback),
			(callback) => db.run('delete from varbinds where device_id = ?', [device.id], callback),
			(callback) => db.run('delete from devices where id = ?', [device.id], callback),
			(callback) => db.run('commit transaction', callback)
		],
		function(err) {
			if (err) 
				return db.run('rollback transaction', (err2) => callback(err));
		
			device.varbind_list.forEach((varbind) => varbind.cache('CLEAR'));
			device.varbind_list = [];
			device.polling();
			device.cache('CLEAR');

			function drop(where, callback) {
				db.run(`drop table ${where}.device${device.id}`, function (err) {
					if (err)
						console.error(__filename, err.message);
					callback();
				})
			}

			async.eachSeries(['history', 'changes'], drop, callback);
		}
	)
}

Device.prototype.save = function (callback) {
	let device = this;
	let isNew = !this.id; 
	let time = new Date().getTime();

	let varbind_list = [];
	let delete_varbind_ids = [];
	
	async.series ([
		function (callback) {
			db.run('begin transaction', callback);
		},

		function (callback) {
			db.upsert(device, ['name', 'description', 'tags', 'ip', 'mac', 'json_protocols', 'is_pinged', 'period', 'timeout', 'force_status_to', 'template'], callback);
		},

		function (callback) {
			try {
				varbind_list = JSON.parse(device.json_varbind_list).map(function (v) {
					if (isNew && v.id)
						delete v.id;
					v.name = v.name || 'Unnamed';
					v.device_id = device.id;
					v.updated = time;
					return new Varbind(v);
				});
				delete device.json_varbind_list;
			} catch (err) {
				return callback(err);
			}

			async.eachSeries(
				varbind_list, 
				(varbind, callback) => db.upsert(varbind, ['device_id', 'name', 'protocol', 'json_address', 'divider', 'value_type', 'json_status_conditions', 'tags', 'updated'], callback), 
				callback
			);
		},

		function (callback) { 
			let sql = 'select id from varbinds where device_id = ? and updated <> ?';
			let params = [device.id, time];
			db.all(sql, params, function (err, rows) {
				if (err)
					return callback(err);

				rows.forEach((r) => delete_varbind_ids.push(r.id));
				callback();
			});
		},

		function (callback) { 
			db.run(`delete from varbinds where id in (${delete_varbind_ids.join()})`, callback);
		},

		function (callback) {
			db.run('commit transaction', callback); 
		}
	], function(err) {
		if (err) 
			return db.run('rollback transaction', (err2) => callback(err));

		device = device.cache();

		delete_varbind_ids.forEach((id) => Varbind.get(id).cache('CLEAR'));
		varbind_list.forEach((v) => v.cache());
		device.updateVarbindList();
		device.prev_status = 0;
		device.status = 0;

		if (!!device.parent_id)
			device.updateParent((err) => (err) ? console.error(err) : null);

		if (isNew)
			db.run(`alter table history.latencies add column device${device.id} real`, (err) => null);

		db.checkHistoryTable(device, (err) => callback(err, device.id));
		device.polling(2000);
	});
}



const checkCondition = {
	'greater' : (v, v1) => !isNaN(v) && !isNaN(v1) && parseFloat(v) > parseFloat(v1),
	'equals' : (v, v1) => v == v1,
	'not-equals' : (v, v1) => v != v1,
	'smaller' : (v, v1) => !isNaN(v) && !isNaN(v1) && parseFloat(v) < parseFloat(v1),
	'empty' : (v) => isNaN(v) && !v,
	'change' : (v, prev) => prev != undefined && v != undefined && prev != v,
	'regexp' : (v, v1) => (new RegExp(v1)).test(v),
	'anything' : (v, v1) => true,
	'error' : (v) => (v + '').indexOf('ERR') == 0
}


Object.assign(Varbind, mixin.get('varbind'));

function Varbind (data) {
	Object.assign(this, data);
	if(this.id)
		this.id = parseInt(this.id);

	this.__type__ = 'varbind';
	Object.defineProperty(this, 'is_expression', {get() {return this.address && !!this.address.expression}});
	Object.defineProperty(this, 'is_status', {get() {return this.status_conditions.length > 0}});

	this.cache = mixin.cache;
	if (!this.value_type)
		this.value_type = 'string';	

	for (let f of ['status_conditions', 'address']) {
		try {
			this[f] = JSON.parse(this['json_' + f]) || {};
		} catch (err) {
			this[f] = {};
			this['json_' + f] = '{}';
		}
	}	
	
	this.tag_list = !!this.tags ? this.tags.toString().split(';').map((t) => t.trim()).filter((t, idx, tags) => tags.indexOf(t) == idx) : [];
	this.tags = this.tag_list.join(';');

	if (this.is_expression)	{ 
		this.expressionCode = '';
	}	
}

// divider is a "number" or "number + char" or "number + r + regexp"
function applyDivider (value, divider) {
	if (isNaN(value) && isNaN(divider)) {
		value = value + '';
		divider = divider + '';
		let pos = divider.indexOf('r');

		if (pos == -1 || value.indexOf('ERR') == 0)		
			return value;

		let re, error, val;
		try {
			re = new RegExp(divider.substring(pos + 1));
			val = (value + '').match(re);
		} catch (err) {
			error = err;
		}
		
		return (error) ? error.message : val && val[1] ? applyDivider(val[1], parseFloat(divider)) : '';
	}	

	if (!value || isNaN(value) || !divider) 
		return value;

	let div = parseFloat(divider);
	let val = parseFloat(value) / div;
	
	if (div == divider)
		return val;

	let lastChar = divider.slice(-1);
	if (lastChar == 'C')
		return (val - 32) * 5 / 9; // Convert Fahrenheit to Celsius

	if (lastChar == 'F')
		return val * 9 / 5 + 32; // Convert Celsius to Fahrenheit

	if (lastChar == 'R') 
		return +val.toFixed(2); // round to .xx

	return val;
}

Varbind.prototype.getParent = function() {
	return mixin.get('device').get(this.device_id);
}

Varbind.prototype.updateStatus = function() {
	if (!this.status_conditions.length)
		return; 

	this.prev_status = this.status;
	this.status = 0;
	for (let i = 0; i < this.status_conditions.length; i++) {	
		let cond = this.status_conditions[i];
		let val = cond.if != 'change' ? cond.value : this.prev_value;
		if(checkCondition[cond.if] && checkCondition[cond.if](this.value, val)) {
			this.status = cond.status;
			break;
		}
	}
}

Varbind.prototype.generateExpressionCode = function() {
	let device = this.getParent();
	let varbind = this;	
	
	if (!varbind.is_expression)
		return '';

	let expr = (varbind.address.expression || '').replace(/\n| /g, '');
	expr = expr.replace(/\$(\w*)/g, function(matched) {
		let name = matched.substring(1);
		let list = device.varbind_list.filter((v) => v.name  == matched || v.name == name).map((v) => v.id);
		return (list.length == 0) ? 'null' : `Varbind.get(${list[0]}).value`;
 	});		

 	varbind.expressionCode = expr;
}

Varbind.prototype.calcExpressionValue = function () {
	if (!this.expressionCode)
		this.generateExpressionCode();	

	let result;
	try {
		let val = eval(this.expressionCode);
		let float = parseFloat(val);
		result = (float == val) ? float : val;
	} catch (err) {
		result = err;
	}
	return result;
}

module.exports = Device;