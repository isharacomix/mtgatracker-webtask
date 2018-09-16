'use latest';

const express = require('express'),
      router = express.Router();
const { MongoClient, ObjectID } = require('mongodb');
const _ = require("underscore")

const {
  createAnonymousToken,
  createToken,
  clientVersionUpToDate,
  getPublicName,
  getGameById,
  DraftPick,
  Game,
  random6DigitCode,
  routeDoc,
  sendDiscordMessage,
  collectionCollection,
  gameCollection,
  deckCollection,
  draftCollection,
  userCollection,
  inventoryCollection,
  notificationCollection,
} = require('../../util')

var secrets; // babel makes it so we can't const this, I am pretty sure
//try {
  secrets = require('../secrets')
//} catch (e) {
//  secrets = require('../secrets-template')
//}

router.get('/', (req, res, next) => {
  res.status(200).send({routes: routeDoc(router.stack)})
})

router.post("/draft-pick", (req, res, next) => {
  console.log("POST /draft-pick")
  const { MONGO_URL, DATABASE } = req.webtaskContext.secrets;
  const model = req.body;
  let hero = model.hero;
  let draftID = model.draftID;

  let draftPick = new DraftPick(model)
  if (!draftPick.isValid()) {
    res.status(400).send({error: draftPick.validationError})
    return;
  }
  delete model.hero;
  delete model.draftID;

  MongoClient.connect(MONGO_URL, (err, client) => {
    if (err) return next(err);
    client.db(DATABASE).collection(draftCollection)
      .find({hero: hero, draftID: draftID})
      .sort({date: -1}).limit(1)
      .next((err, draftObj) => {
        // decide if we should use existing, or create new object
        let lastPick = draftObj.picks[draftObj.picks.length - 1]
        let fitsExistingDraft = draftObj &&
          (
            lastPick.packNumber < model.packNumber ||
              (
                lastPick.packNumber == model.packNumber &&
                lastPick.pickNumber < model.pickNumber
              )
          )
        if (fitsExistingDraft) {
          draftObj.picks.push(model)
          console.log("fits!")
          console.log(draftObj)
          console.log(`pack: ${lastPick.packNumber} <= ${model.packNumber}: ${lastPick.packNumber <= model.packNumber}`)
          console.log(`pick: ${lastPick.pickNumber} <= ${model.pickNumber}: ${lastPick.pickNumber <= model.pickNumber}`)

          client.db(DATABASE).collection(draftCollection).save(draftObj, (err, result) => {
            client.close();
            res.status(201).send(result);
          })
        } else {
          console.log("no fit :(")
          if (draftObj) {
            console.log(`pack: ${lastPick.packNumber} <= ${model.packNumber}: ${lastPick.packNumber <= model.packNumber}`)
            console.log(`pick: ${lastPick.pickNumber} <= ${model.pickNumber}: ${lastPick.pickNumber <= model.pickNumber}`)
          } else {
            console.log("because: no draftObj")
          }

          if (lastPick.packNumber == model.packNumber &&
              lastPick.pickNumber == model.pickNumber &&
              lastPick.pack == model.pack) {
                console.log("draft object is the same as the last pick! discarding")
                client.close();
                res.status(304).send(lastPick);
          } else {
            console.log({hero: hero, draftID: draftID})
            draftObj = {
              date: new Date(),
              picks: [model],
              hero: hero,
              draftID: draftID,
            }
            client.db(DATABASE).collection(draftCollection).insertOne(draftObj, (err, result) => {
              client.close();
              res.status(201).send(result);
            })
          }
        }
    })
  })
})


// duplicated from /anon-api
// covered: test_post_game
router.post('/game', (req, res, next) => {
  const { MONGO_URL, DATABASE } = req.webtaskContext.secrets;
  const model = req.body;

  if (model.date === undefined) {
    model.date = new Date()
  } else {
    model.date = new Date(Date.parse(model.date))
  }

  if (model.anonymousUserID) {
    let cleanModel = {
      date: model.date,
      anonymousUserID: model.anonymousUserID
    } // in case someone tries to sneak junk in this way, filter it out
    MongoClient.connect(MONGO_URL, (err, client) => {
      if (err) return next(err);
      client.db(DATABASE).collection(gameCollection).insertOne(cleanModel, (err, result) => {
        client.close();
        if (err) return next(err);
        res.status(201).send(result);
        return
      })
    })
  } else {
    let game = new Game(model)
    if (!game.isValid()) {
      res.status(400).send({error: game.validationError})
      return;
    }

    clientVersionUpToDate(model.client_version, req.webtaskContext.storage).then((clientVersionCheck) => {
      model.clientVersionOK = clientVersionCheck.ok
      model.latestVersionAtPost = clientVersionCheck.latest
      model.trackerAuthed = true

      if (model.hero === undefined || model.opponent === undefined) {
        if (model.players[0].deck.poolName.includes("visible cards") && !model.players[1].deck.poolName.includes("visible cards")) {
          model.hero = model.players[1].name
          model.opponent = model.players[0].name
        } else if (model.players[1].deck.poolName.includes("visible cards") && !model.players[0].deck.poolName.includes("visible cards")) {
          model.hero = model.players[0].name
          model.opponent = model.players[1].name
        } else {
          res.status(400).send({error: "invalid schema", game: result});
          return;
        }
      }

      if (!model.elapsedTimeSeconds) {
        let totalSeconds = 0.0;
        let timeSplit = model.elapsedTime.split(":")
        totalSeconds += parseInt(timeSplit[0]) * 60 * 60;
        totalSeconds += parseInt(timeSplit[1]) * 60;
        totalSeconds += parseFloat(timeSplit[2]);
        model.elapsedTimeSeconds = totalSeconds;
      }

      for (let player of model.players) {
        if (!player.timeSpentSeconds) {
          player.timeSpentSeconds = 0.0;
          let playerTimeSplit = player.timeSpent.split(":")
          player.timeSpentSeconds += parseInt(playerTimeSplit[0]) * 60 * 60;
          player.timeSpentSeconds += parseInt(playerTimeSplit[1]) * 60;
          player.timeSpentSeconds += parseFloat(playerTimeSplit[2]);
        }
      }

      MongoClient.connect(MONGO_URL, (err, client) => {
        if (err) return next(err);
        //client, database, username, createIfDoesntExist, isUser
        getPublicName(client, DATABASE, model.hero, true, true).then(() => {
          getPublicName(client, DATABASE, model.opponent, true, false).then(() => {
            getGameById(client, DATABASE, game.get("gameID"), (result, err) => {
              if (result !== null) {
                res.status(400).send({error: "game already exists", game: result});
                return;
              }
              client.db(DATABASE).collection(gameCollection).insertOne(model, (err, result) => {
                let deckQuery = {owner: model.hero, deckID: model.players[0].deck.deckID}
                client.db(DATABASE).collection(deckCollection).find(deckQuery).limit(1).next((err, result) => {
                  if (err) return next(err);
                  if (result == null) { // new deck, we need to make the record
                    result = {
                      owner: model.hero,
                      deckID: model.players[0].deck.deckID,
                      deckName: model.players[0].deck.poolName,
                      wins: [],
                      losses: []
                    }
                  }
                  result.deckName = model.players[0].deck.poolName  // get the latest name
                  if (model.winner == model.hero) {
                    result.wins.push(model.gameID)
                  } else {
                    result.losses.push(model.gameID)
                  }
                  client.db(DATABASE).collection(deckCollection).save(result)
                  client.close();
                  res.status(201).send(result);
                })
              });
            })
          })
        })
      });
    })
  }
});


// TODO: uncovered
router.post('/inventory', (req, res, next) => {
  console.log("POST /inventory")
  const { MONGO_URL, DATABASE } = req.webtaskContext.secrets;
  const model = req.body;

  MongoClient.connect(MONGO_URL, (err, client) => {
    let collection = client.db(DATABASE).collection(inventoryCollection)

    // before we add a date, test if the object returns a document when used as a query
    // if so, we should do nothing
    delete model.log_line;
    delete model.block_title_sequence;
    delete model.request_or_response;
    delete model.block_title;

    let queryPromises = [];
    let queries = [];

    let insertPromises = [];
    let inserted = [];

    Object.keys(model).forEach(key => {
      if (key != "playerId") {
        queries.push(key)
        queryPromises.push(collection.find({"playerId": model.playerId, "type": key}).sort({date: -1}).limit(1).next())
      }
    })
    Promise.all(queryPromises).then(qPromiseResults => {
      for (let i = 0; i < queries.length; i++) {
        let key = queries[i]
        let result = qPromiseResults[i]
        let modelForKey = {"type": key, "value": model[key], "playerId": model.playerId}

        // incoming model won't have these fields
        // we're not using result again, so we can edit the obj directly
        if (result) {
          delete result._id;
          delete result.date;
        }
        if (!_.isEqual(result, modelForKey)) {
          modelForKey.date = new Date();
          insertPromises.push(collection.insertOne(modelForKey))
          inserted.push(key)
        }
      }
      if (insertPromises) {
        Promise.all(insertPromises).then(promiseRes => {
          client.close();
          if (err) return next(err);
          res.status(201).send({"inserted": inserted});
        })
      } else {
        res.sendStatus(202)
      }
    })
  });
});


router.post('/rankChange', (req, res, next) => {
  const { MONGO_URL, DATABASE } = req.webtaskContext.secrets;
  const model = req.body;

  MongoClient.connect(MONGO_URL, (err, client) => {
    if (err) return next(err);
    //client, database, username, createIfDoesntExist, isUser
    let collection = client.db(DATABASE).collection(gameCollection)
    let cursor = collection.find({"players.0.userID": model.playerId}).sort({date: -1}).limit(1).next((err, result) => {
      if (err) return next(err);
      if (result == null) {
        res.status(400).send({error: "no game found", game: result});
        return;
      }
      if (result.rankChange) {
        res.status(400).send({error: "game already has rank", game: result});
        return;
      }
      result.rankChange = model;
      collection.save(result)
      res.status(200).send(result)
    })
  })
});


router.post('/collection', (req, res, next) => {
  console.log("POST /collection")
  const { MONGO_URL, DATABASE } = req.webtaskContext.secrets;
  const model = req.body;

  // some metadata gets added by the tracker; remove everything that isn't a card count
  // we know hero is fine because this route is protected by ID verifying middleware, safe to throw away hero
  delete model.hero
  delete model.block_title
  delete model.request_or_response
  delete model.block_title_sequence

  MongoClient.connect(MONGO_URL, (err, client) => {
    if (err) return next(err);
    let collection = client.db(DATABASE).collection(collectionCollection)
    // lol, say it 5 times fast

    let cursor = collection.find({"owner": req.user.user}).sort({date: -1}).limit(1).next((err, result) => {
      if (err) return next(err);
      // TODO, gh issue #2: this if doesn't appear to be working, but
      // debugging is difficult because objects are so large. shrug, minor extra load on the DB I guess
      if (result && result.collection == model) {
        console.log("model already matches, 304")
        res.status(304).send({error: "player collection unmodified"});
        return;
      } else {
        console.log(result.collection)
      }

      // at this point, either collection doesn't match, or doesn't exist
      // check for latter, if so, set up object boilerplate
      if (result == null) {
        result = {
          owner: req.user.user,
          collection: {}
        }
      }
      // update the collection, either way
      result.collection = model
      // save it
      collection.save(result).then(saveResult => {
        res.status(200).send(saveResult)
      })
    })
  })
});

module.exports = router