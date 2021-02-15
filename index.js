const express = require('express')
const cors = require('cors')
const path = require('path')
const pgdb = require('./db')
const async = require('async')
var fs = require('fs')

const RingCentral = require('@ringcentral/sdk').SDK
const PhoneEngine = require('./supervisor-engine');

var agentInfo = {
    id: "",
    mergedTranscription: {
      index: -1,
      customer: [],
      agent: []
    }
}
var supervisorExtensionId = ""

// Create the server
const app = express()

app.use(express.static(path.join(__dirname, 'client/build')))

require('dotenv').config()


let supervisor = new PhoneEngine()
var eventResponse = null
var g_subscriptionId = ""

createTable((err, res) => {
    console.log(res)
    if (err) {
        console.log(err, res)
    }else{
        console.log("DONE => Ready to login")
    }
});

app.get('/events', cors(), async (req, res) => {
  console.log("METHOD EVENTS")
  res.set({
    'Connection': 'keep-alive',
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.statusCode = 200;
  eventResponse = res
})

app.get('/enable_translation', cors(), async (req, res) => {
  console.log("ENABLE TRANSLATION")
  var queryData = req.query;
  console.log(queryData.enable)
  supervisor.enableTranslation(queryData.enable)
  res.statusCode = 200;
  res.end();
})

app.get('/enable_recording', cors(), async (req, res) => {
  console.log("ENABLE RECORDING")
  var queryData = req.query;
  console.log(queryData.enable)
  supervisor.enableRecording(queryData.enable)
  res.statusCode = 200;
  res.end();
})

// Remove all subscriptions. Needed when changing test environments. E.g. localhost and heroku
app.get('/delete_subscriptions', cors(), async (req, res) => {
  console.log("DELETE ALL SUBs")
  deleteAllRegisteredWebHookSubscriptions()
  res.statusCode = 200;
  res.end();
})

app.get('*', cors(), (req, res) => {
  console.log("LOAD INDEX")
  res.set({
    'Connection': 'keep-alive',
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.sendFile(path.join(__dirname + '/client/build/index.html'))
  console.log("call login?")
  login()
})

// Receiving RingCentral webhooks notifications
app.post('/webhookcallback', function(req, res) {
  console.log('/webhookcallback')
    if(req.headers.hasOwnProperty("validation-token")) {
        res.setHeader('Validation-Token', req.headers['validation-token']);
        res.statusCode = 200;
        res.end();
    }else{
        var body = []
        req.on('data', function(chunk) {
            body.push(chunk);
        }).on('end', function() {
            body = Buffer.concat(body).toString();
            //console.log(body)
            //console.log("=======")
            var jsonObj = JSON.parse(body)
            if (jsonObj.subscriptionId == g_subscriptionId) {
              for (var party of jsonObj.body.parties){
                if (party.direction === "Inbound"){
                  //if (party.to.phoneNumber == "+12092484775"){
                    if (party.status.code === "Proceeding"){
                      if (agentInfo.id == party.extensionId)
                        sendPhoneEvent('ringing')
                    }else if (party.status.code === "Answered"){
                      if (party.extensionId == agentInfo.id){
                        getCallSessionInfo(jsonObj)
                      }
                    }else if (party.status.code === "Disconnected"){
                      if (party.extensionId == agentInfo.id){
                        sendPhoneEvent('idle')
                      }
                    }
                  //}
                }
              }
              res.statusCode = 200;
              res.end();
            }
        });
    }
})

const PORT = process.env.PORT || 5000
app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`)
})


function sendPhoneEvent(status){
  var res = 'event: phoneEvent\ndata: ' + status + '\n\n'
  if (eventResponse != null){
    if (!eventResponse.finished) {
        eventResponse.write(res);
    }else{
      console.log("eventResponse is finished")
    }
  }else{
    console.log("eventResponse is null")
  }
}

function mergingChannels(speakerId, transcript){
  if (speakerId == 0){ // customer
    for (let i = 0; i < agentInfo.mergedTranscription.customer.length; i++) {
      if (agentInfo.mergedTranscription.customer[i].index === transcript.index){
        transcript.index = agentInfo.mergedTranscription.index
        return sendTranscriptEvents(transcript)
      }
    }
    agentInfo.mergedTranscription.index++
    var item = {
      index: transcript.index,
      text: transcript.text
    }
    agentInfo.mergedTranscription.customer.push(item)
    transcript.index = agentInfo.mergedTranscription.index
    sendTranscriptEvents(transcript)
  }else{ // agent
    for (let i = 0; i < agentInfo.mergedTranscription.agent.length; i++) {
      if (agentInfo.mergedTranscription.agent[i].index === transcript.index){
        transcript.index = agentInfo.mergedTranscription.index
        return sendTranscriptEvents(transcript)
      }
    }
    agentInfo.mergedTranscription.index++
    var item = {
      index: transcript.index,
      text: transcript.text
    }
    agentInfo.mergedTranscription.agent.push(item)
    transcript.index = agentInfo.mergedTranscription.index
    sendTranscriptEvents(transcript)
  }
}

function sendTranscriptEvents(transcript) {
  var t = JSON.stringify(transcript)
  var res = 'event: transcriptUpdate\ndata: ' + t + '\n\n'
  if (eventResponse != null){
    if (!eventResponse.finished) {
        eventResponse.write(res);
    }else{
      console.log("eventResponse is finished")
    }
  }else{
    console.log("eventResponse is null")
  }
}

module.exports.mergingChannels = mergingChannels;
module.exports.sendPhoneEvent = sendPhoneEvent;

const rcsdk = new RingCentral({
  server: process.env.RINGCENTRAL_SERVER_URL,
  clientId: process.env.RINGCENTRAL_CLIENT_ID,
  clientSecret: process.env.RINGCENTRAL_CLIENT_SECRET
})

async function loadSavedSubscriptionId(extId, callback){
  var table = process.env.ENVIRONMENT + "_supervision_subscriptionids"
  var query = `SELECT sub_id from ${table} WHERE ext_id=${extId}`
  pgdb.read(query, async (err, result) => {
      if (!err){
          if (result.rows.length){
              var row = result.rows[0]
              if (row['sub_id'] != ""){
                console.log("has subId => call checkRegisteredWebHookSubscription")
                callback(null, row['sub_id'])
              }else{
                console.log("subId empty => call startWebHookSubscription")
                callback("err", "")
              }
          }else{
              console.log("no subId => call startWebHookSubscription")
              callback("err", "")
          }
      }
  })
}

function startNotification(){
  console.log("startNotification")
  loadSavedSubscriptionId(supervisorExtensionId, async function(err, res){
      if (err){
          startWebhookSubscription()
      }else{
          console.log("saved subId: " + res)
          checkRegisteredWebHookSubscription(res)
      }
  })
}

var platform = rcsdk.platform();

platform.on(platform.events.loginSuccess, async function(e){
  console.log("Login success")
  readCallMonitoringGroup((err, resp) => {
    if (!err){
      console.log("response: "  + resp)
      console.log("supervisorExtensionId: " + supervisorExtensionId)
      supervisor.initializePhoneEngine(rcsdk)
      startNotification()
    }else{
      console.log(err)
    }
  })
});

platform.on(platform.events.refreshError, async function(e){
    console.log(e.message)
    try{
      console.log("Cannot refresh token => login again")
      await platform.login({
        username: process.env.RINGCENTRAL_USERNAME,
        extension: process.env.RINGCENTRAL_EXTENSION,
        password: process.env.RINGCENTRAL_PASSWORD
      })
    }catch(e){
      console.log(e.message)
      console.log("LOGIN FAILED")
      return
    }

});

platform.on(platform.events.refreshSuccess, async function(res){
    console.log("Refresh token success")
});

async function login(){
  var loggedIn = await rcsdk.platform().loggedIn()
  if (loggedIn){
    console.log("Still logged in => good to call APIs")
    readCallMonitoringGroup((err, resp) => {
      if (!err){
        console.log("response: "  + resp)
        console.log("supervisorExtensionId: " + supervisorExtensionId)
        supervisor.initializePhoneEngine(rcsdk)
        startNotification()
      }else{
        console.log(err)
      }
    })
  }
}

async function logout(){
  if (supervisorExtensionId != ""){
    var table = process.env.ENVIRONMENT + "_supervision_subscriptionids"
    var query = `SELECT sub_id from ${table} WHERE ext_id=${supervisorExtensionId}`
    pgdb.read(query, async (err, result) => {
      if (!err){
          if (result.rows.length){
              var row = result.rows[0]
              if (row['sub_id'] != ""){
                deleteRegisteredWebHookSubscription(row['sub_id'], async function(err, res){
                  await rcsdk.platform().logout()
                  query = `UPDATE ${table} SET tokens='', sub_id='' WHERE ext_id=${supervisorExtensionId}`
                  pgdb.update(query, (err, result) =>  {
                    if (err){
                      console.error(err.message);
                    }
                    console.log("reset subscription")
                  })
                  return
                })
              }
          }
      }
    })
  }
}

function createTable(callback){
  var table = process.env.ENVIRONMENT + "_supervision_subscriptionids"
  pgdb.create_table("supervision_subscriptionids", table, (err, res) => {
      if (err) {
          console.log(err, res)
          callback(err, null)
      }else{
          callback(null, "done")
      }
  })
}

async function getCallSessionInfo(payload){
  var body = payload.body
  var endpoint = `/restapi/v1.0/account/~/telephony/sessions/${body.telephonySessionId}`
  var res = await rcsdk.get(endpoint)
  var json = await res.json()
  console.log(JSON.stringify(json))
  agentInfo.mergedTranscription = {
    index: -1,
    customer: [],
    agent: []
  }
  async.each(json.parties,
      function(party, callback){
        var params = {
          ownerId: payload.ownerId,
          telSessionId: json.id,
          extensionId: agentInfo.id.toString() //
        }
        if (party.direction == "Outbound"){
            params['partyId'] = party.id
            params['speakerName'] = (party.from.name) ? party.from.name : "Customer"
            params['speakerId'] = 0 // a customer
            console.log(params)
            submitSuperviseRequest(params)
        }else{
          if (party.extensionId == agentInfo.id.toString()){
            params['partyId'] = party.id
            params['speakerName'] = (party.to.name) ? party.to.name : "Agent"
            params['speakerId'] = 1 // an agent
            console.log(params)
            submitSuperviseRequest(params)
          }
        }
        callback(null, "")
      },
      function(err){
        console.log("done")
      }
    );
}

async function submitSuperviseRequest(inputParams){
  if (supervisor.deviceId != ""){
      try{
        var endpoint = `/restapi/v1.0/account/~/telephony/sessions/`
        endpoint += `${inputParams.telSessionId}/parties/${inputParams.partyId}/supervise`
        var agentObj = {}
        agentObj['speakerName'] = inputParams.speakerName
        agentObj['partyId'] = inputParams.partyId
        agentObj['speakerId'] = inputParams.speakerId
        supervisor.setChannel(agentObj)
        var params = {
                mode: 'Listen',
                supervisorDeviceId: supervisor.deviceId
              }
        params['agentExtensionId'] = inputParams.extensionId
        var res = await rcsdk.post(endpoint, params)
        console.log("POST supervise succeeded")
      }catch(e) {
        console.log("POST supervise failed")
        console.log(e.message)
      }
  }else{
    console.log("No device Id")
  }
}

async function startWebhookSubscription() {
    var eventFilters = [
      `/restapi/v1.0/account/~/extension/${agentInfo.id}/telephony/sessions`
    ]
    console.log(process.env.DELIVERY_ADDRESS)
    try{
      var res = await  rcsdk.post('/restapi/v1.0/subscription',
                {
                    eventFilters: eventFilters,
                    deliveryMode: {
                        transportType: 'WebHook',
                        address: process.env.DELIVERY_ADDRESS
                    }
                })
      console.log("Subscribed")
      var jsonObj = await res.json()
      console.log("Ready to receive telephonyStatus notification via WebHook.")
      g_subscriptionId = jsonObj.id
      storeSubscriptionId(jsonObj.id)
    }catch(e){
      console.log(e.message)
    }
}

function storeSubscriptionId(subId){
  var table = process.env.ENVIRONMENT + "_supervision_subscriptionids"
  query = `UPDATE ${table} SET sub_id='${subId}' WHERE ext_id=${supervisorExtensionId}`
  console.log(query)
  pgdb.update(query, (err, result) =>  {
      if (err){
        console.error(err.message);
      }
    })
}

async function readCallMonitoringGroup(callback){
  console.log(process.env.SUPERVISOR_GROUP_NAME)
  console.log(process.env.AGENT_EXTENSION_NUMBER)
  var resp = await rcsdk.get('/restapi/v1.0/account/~/call-monitoring-groups')
  var jsonObj = await resp.json()
  for (var group of jsonObj.records){
    if (group.name == process.env.SUPERVISOR_GROUP_NAME){
      var resp = await rcsdk.get('/restapi/v1.0/account/~/call-monitoring-groups/' + group.id + "/members")
      var jsonObj1 = await resp.json()
      for (var member of jsonObj1.records){
        if (member.permissions[0] == "Monitored"){
          if (member.extensionNumber == process.env.AGENT_EXTENSION_NUMBER){
            console.log("Monitored Agent: " + member.extensionNumber)
            agentInfo.id = member.id
            agentInfo.mergedTranscription = {
                  index: -1,
                  customer: [],
                  agent: []
                  }
          }
        }else if (member.permissions[0] == "Monitoring"){
          console.log("Supervisor: " + member.extensionNumber)
          supervisorExtensionId = member.id
        }
      }
      return callback(null, supervisorExtensionId)
    }
  }
  callback("Cannot find call monitor group", "")
}

async function checkRegisteredWebHookSubscription(subscriptionId) {
    try {
      let response = await rcsdk.get('/restapi/v1.0/subscription')
      let json = await response.json()
      console.log("checkRegisteredWebHookSubscription: " + json.records.length)
      if (json.records.length > 0){
        for(var record of json.records) {
          if (record.id == subscriptionId) {
            console.log("sub id: " + record.id)
            if (record.deliveryMode.transportType == "WebHook"){
              if (process.env.DELETE_EXISTING_WEBHOOK_SUBSCRIPTION == 1){
                // Needed for local test as ngrok address might be expired
                console.log("Subscription exist => delete it then subscribe a new one")
                await rcsdk.delete('/restapi/v1.0/subscription/' + record.id)
                startWebhookSubscription()
              }else{
                //await readCallMonitoringGroup() WHY??
                g_subscriptionId = subscriptionId
                if (record.status != "Active"){
                  console.log("Subscription is not active => renew it")
                  await rcsdk.post('/restapi/v1.0/subscription/' + record.id + "/renew")
                  console.log("Renew: " + record.id)
                }else {
                  console.log("Subscription is active => good to go.")
                  console.log("sub status: " + record.status)
                }
              }
            }
          }
        }
      }else{
        console.log("No subscription for this service => create one.")
        startWebhookSubscription()
      }
    }catch(e){
      console.log("checkRegisteredWebHookSubscription ERROR")
      console.log(e)
      login()
    }
}

/// Clean up WebHook subscriptions
async function deleteRegisteredWebHookSubscription(subscriptionId, callback) {
  let response = await rcsdk.get('/restapi/v1.0/subscription')
  let json = await response.json();
  if (json.records.length > 0){
    for (var record of json.records) {
      if (record.deliveryMode.transportType == "WebHook"){
        if (subscriptionId == record.id){
          await rcsdk.delete('/restapi/v1.0/subscription/' + record.id)
          console.log("Deleted")
          return callback(null, "deleted")
        }
      }
    }
    return callback(null, "no subscription")
  }else{
    return callback(null, "no subscription")
  }
}

async function deleteAllRegisteredWebHookSubscriptions() {
  let response = await rcsdk.get('/restapi/v1.0/subscription')
  let json = await response.json();
  if (json.records.length > 0){
    for (var record of json.records) {
      if (record.deliveryMode.transportType == "WebHook"){
          await rcsdk.delete('/restapi/v1.0/subscription/' + record.id)
          console.log("Deleted")
      }
    }
    console.log("Deleted all")
    storeSubscriptionId("")
  }else{
    console.log("No subscription to delete")
  }
}
