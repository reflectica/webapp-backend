import { Configuration, OpenAIApi } from "openai";
import { config } from 'dotenv';
import express, { request } from "express";
import cors from "cors";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import bodyParser from "body-parser";
import Sentiment from 'sentiment';
import AWS from 'aws-sdk'
import admin from "firebase-admin"
import nodemailer from 'nodemailer';
import axios from 'axios';

config();
const sentiment = new Sentiment();
const app = express();
app.use(bodyParser.json());
app.use(cors())


app.get('/', (req, res) => {
  res.send("app running")
});


const transporter = nodemailer.createTransport({
  service: 'Gmail', // e.g., 'Gmail' or 'Outlook'
  auth: {
    user: 'reflectica.ai@gmail.com',
    pass: process.env.GMAIL_PASS_KEY,
  },
});

const moodTable = {
  "-5": 0,
  "-4": 1,
  "-3": 2,
  "-2": 3,
  "-1": 4,
  "0": 5,
  "1": 6,
  "2": 7,
  "3": 8,
  "4": 9,
  "5": 10
}

admin.initializeApp({
  credential: admin.credential.cert({
    "type": process.env.FIREBASE_TYPE_OF_ADMIN,
    "project_id": process.env.FIREBASE_PROJECT_ID,
    "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
    "private_key": process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    "client_email": process.env.FIREBASE_CLIENT_EMAIL,
    "client_id": process.env.FIREBASE_CLIENT_ID,
    "auth_uri": process.env.FIREBASE_AUTH_URI,
    "token_uri": process.env.FIREBASE_TOKEN_URI,
    "auth_provider_x509_cert_url": process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
    "client_x509_cert_url": process.env.FIREBASE_CLIENT_CERT_URL,
    "universe_domain": process.env.FIREBASE_UNIVERSAL_DOMAIN
  }),
  databaseURL: process.env.DATABASE_URL, // Replace with your Firestore database URL
});

const db = admin.firestore();

const sessionTextsRef = db.collection('sessionTexts');
const summaryRef = db.collection('summaries');
const subscribedEmails = db.collection("subscribedEmails");
const userRef = db.collection("users");
const registerSummary = async (shortMessage, longMessage, moodPercentage, sessionId, userId, chatLog) => {
  const timeStamp = new Date().toISOString();
  // Data to be added to the document
  const data = {
    shortSummary: shortMessage,
    longSummary: longMessage,
    moodPercentage: moodPercentage,
    time: timeStamp,
    sessionId: sessionId,
    uid: userId,
    chatlog: chatLog
  };

  // Add data to the collection
  summaryRef.add(data)
    .then((docRef) => {
      console.log('Document written with ID: ', docRef.id);
    })
    .catch((error) => {
      console.error('Error adding document: ', error);
    });
}

const getSentiment = async (uid, sessionId) => {
  try {
    const querySnapshot = await sessionTextsRef
      .where("uid", '==', uid)
      .where("sessionId", "==", sessionId)
      .orderBy("time", 'asc')
      .get();

    if (querySnapshot.empty) {
      console.log('No matching documents.');
      return;
    }
    const userMessages = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      data.chatlog.forEach((item) => {
        if (item.role === "user") {
          userMessages.push(item.content)
        }
      })
    });
    
    const joinedMessages = userMessages.join('.')
    const analyze = sentiment.analyze(joinedMessages)
    if(analyze.score < -5) return -5
    if(analyze.score > 5) return 5
    return analyze.score
  } catch (error) {
    console.error('Error getting documents: ', error);
  }
}
const callOpenAi = async (message) => {
  const completion = await openai.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: message,
    frequency_penalty: 1.13,
    temperature: 0.8,
  });

  return completion.data.choices[0].message.content
}
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const deleteAllUserSummaries = async (uid) => {

  await summaryRef.where("uid", "==", uid)
    .get()
    .then((querySnapshot) => {
      if (querySnapshot.empty) {
        console.log('No matching documents to delete.');
        return;
      }

      const batch = db.batch();

      querySnapshot.forEach((doc) => {
        batch.delete(doc.ref);
      });

      return batch.commit();
    })
    .then(() => {
      console.log('Bulk delete operation completed successfully.');
    })
    .catch((error) => {
      console.error('Error deleting documents: ', error);
    });

  await userRef.where("uid", "==", uid)
    .get()
    .then((querySnapshot) => {
      if (querySnapshot.empty) {
        console.log('No matching documents to delete.');
        return;
      }

      const batch = db.batch();

      querySnapshot.forEach((doc) => {
        batch.delete(doc.ref);
      });

      return batch.commit();
    })
    .then(() => {
      console.log('Bulk delete operation completed successfully.');
    })
    .catch((error) => {
      console.error('Error deleting documents: ', error);
    });
  
}

const deleteAllTexts = async (uid,sessionId) => {
  await sessionTextsRef.where("uid", '==', uid)
  .where("sessionId", "==", sessionId)
    .get()
    .then((querySnapshot) => {
      if (querySnapshot.empty) {
        console.log('No matching documents to delete.');
        return;
      }

      // Create a batch for bulk deletion
      const batch = db.batch();

      querySnapshot.forEach((doc) => {
        batch.delete(doc.ref);
      });

      // Commit the batch to perform the deletion
      return batch.commit();
    })
    .then(() => {
      console.log('Bulk delete operation completed successfully.');
    })
    .catch((error) => {
      console.error('Error deleting documents: ', error);
    });
}


const callAI = async (message) => {
  const requestData = {
    "input": {
      "prompt": `<<SYS>>You are a therapist. Show concern and ask many questions. Do not use emojis. Be human-like, helpful, and personal. do not give more than 3 sentence responses and keep your responses short. Keep answers short and meaningful.<</SYS>>${message}`,
      "max_new_tokens": 500,
      "temperature": 0.8,
      "top_k": 50,
      "top_p": 0.7,
      "repetition_penalty": 1.15,
      "batch_size": 8,
      "stop": ["</s>"]
    }
  };

  return new Promise((resolve, reject) => {
    axios.post(process.env.RUNAPOD_ENDPOINT_URL, requestData, {
      headers: {
        authorization: `X6DI8GMZ6W5SG14MLGSNZHEIZSK4A4WLWV28QZJV`
      }
    })
      .then(response => {
        resolve(response.data.output);  
      })
      .catch(error => {
        reject(error); 
      });
  });
}

const getDashboardData = async (userId) => {
  const result = await summaryRef.where("uid", '==', userId)
    .orderBy("time", 'desc')
    .get()
    .then((querySnapshot) => {
      if (querySnapshot.empty) {
        console.log('No matching documents.');
        return;
      }
      let additionOfMentalScore = 0
      const resultArray = []
      querySnapshot.forEach((doc) => {
        additionOfMentalScore = Number(additionOfMentalScore) + Number(doc.data().moodPercentage)
        resultArray.push(doc.data())
      });

      const overallMentalHealth = additionOfMentalScore / resultArray.length
      const prevOverall = resultArray.length > 1 ? resultArray[0].moodPercentage - resultArray[1].moodPercentage : resultArray[0].moodPercentage
      return { summaryData: resultArray, totalSessions: resultArray.length, overallMentalHealth: overallMentalHealth, prevOverall: prevOverall}
    })
    .catch((error) => {
      console.error('Error getting documents: ', error);
      console.log()
    });
  return result
}

const getAllUserSessions = async (userId) => {
  const today = new Date();
  const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const result = await summaryRef.where("uid", '==', userId)
    .where('time', '>=', firstDayOfMonth.toISOString())
    .where('time', '<=', lastDayOfMonth.toISOString())
    .orderBy("time", 'desc')
    .get()
    .then((querySnapshot) => {
      if (querySnapshot.empty) {
        console.log('No matching documents.');
        return;
      }
      const resultArray = []
      querySnapshot.forEach((doc) => {
        resultArray.push(doc.data())
      });
      return { summaryData: resultArray, totalSessions: resultArray.length}
    })
    .catch((error) => {
      console.error('Error getting documents: ', error);
    });
  return result
}


const addTextData = async (uid, role, transcript, message, sessionId) => {

  const timeStamp = new Date().toISOString();

  // Data to be added to the document
  const data = {
    uid: uid,
    time: timeStamp,
    sessionId: sessionId,
    message: message,
    chatlog: [{role: role, content: transcript}]
    // Add more fields as needed
  };

  await sessionTextsRef.where("sessionId", "==", sessionId).where("uid", "==", uid)
    .get()
    .then( async(querySnapshot) => {
      if (querySnapshot.empty) {
        await sessionTextsRef.add(data)
        return;
      }

      querySnapshot.forEach(async (doc) => {
        await doc.ref.update({
          message: doc.data().message.concat(message),
          chatlog: [...doc.data().chatlog, { role: role, content: transcript }]
        });
        console.log("Document updated successfully");
        return;
      });

    })
    .catch((error) => {
      console.error('Error adding or updating document: ', error);
    });
}

const checkForExistingData = async (email) => {
  const q = await subscribedEmails.where("email", "==", email).get()
    .then((querySnapshot) => {
      return querySnapshot.empty
    })
  return q;
};

const registerEmailForLoopIntoDb = async (email) => {
  const checkIfEmailExistAlready = await checkForExistingData(email)
  if(checkIfEmailExistAlready) {
    // Data to be added to the document
    const data = {
      email: email
    };
    await subscribedEmails.add(data)
      .then((docRef) => {
        console.log('Document written with ID: ', docRef.id);
      })
      .catch((error) => {
        console.error('Error adding document: ', error);
      });
    
  await sendLoopMail(email)

  return 
  }
}


const getTexts = async (uid, sessionId) => {
  const result = await sessionTextsRef.where("uid", '==', uid)
    .where("sessionId", "==", sessionId)
    .orderBy("time", 'asc')
    .get()
    .then((querySnapshot) => {
      if (querySnapshot.empty) {
        console.log('No matching documents.');
        return;
      }
      let resultObject;
      querySnapshot.forEach((doc) => {
        console.log(doc.data())
        resultObject = { chatlog: doc.data().chatlog, aiLog: doc.data().message}
      });
      return resultObject
    })
    .catch((error) => {
      console.error('Error getting documents: ', error);
    });
  return result
}

const sendLoopMail = async (email) => {
  const mailOptions = {
    from: 'reflectica.ai@gmail.com',
    to: email,
    subject: `Thank You For Subscribing To Our Loop`,
    text: `We will keep you in the loop! Stay tuned!`,
  };

  await transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Error sending email:', error);
    } else {
      console.log('Email sent:', info.response);
    }
  });
}

const getTextFromSummaryTable = async (sessionId, uid) => {
  const result = summaryRef.where("sessionId", "==", sessionId)
  .where("uid", "==", uid)
  .get()
  .then((querySnapshot) => {
    if (querySnapshot.empty) {
      console.log('No matching documents.');
      return;
    }
    let returnData
    querySnapshot.forEach((doc) => {
      returnData = doc.data().chatLog
    });
    console.log(returnData)
    return returnData
  })

  return result
}


const sendSupportMail = async (firstName, lastName, email, phoneNumber, message) => {
  const mailOptions = {
    from: 'reflectica.ai@gmail.com',
    to: 'reflectica.ai@gmail.com',
    subject: `Support Mail from ${firstName} ${lastName}`,
    text: `Hi Reflica Team, we have a new support mail. Customers phone number is ${phoneNumber} and their email adress is ${email}. Their message is ${message}`,
  };

  await transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Error sending email:', error);
    } else {
      console.log('Email sent:', info.response);
    }
  });
}

const emailAllUserTranscripts = async (userId) => {
 const allTranscriptsForUser = await summaryRef.where("uid", "==", userId)
  .get().then((querySnapshot) => {
    if (querySnapshot.empty) {
      console.log('No matching documents.');
      return;
    }

    let returnData = ""
    querySnapshot.forEach((doc) => {
      console.log("doc data",doc.data())
      const stringSession = `${JSON.stringify(doc.data().chatlog)} \n`
      console.log("stringSession",stringSession)
      returnData += stringSession
    });
    console.log("returnData",returnData)
    return returnData
  })
  await sendUserTranscriptsAfterDeletion(userId, allTranscriptsForUser)
  return
}

const sendUserTranscriptsAfterDeletion = async (userId, userTranscript) => {
  console.log("userTranscripts",userTranscript)
  const mailOptions = {
    from: 'reflectica.ai@gmail.com',
    to: 'reflectica.ai@gmail.com',
    subject: `Account Deleted: ${userId}`,
    text: `${userTranscript}`,
  };

  await transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Error sending email:', error);
    } else {
      console.log('Email sent:', info.response);
    }
  });
}

const updateFieldInUserCollection = async (userId, value, fieldName) => {
  const userDocument = userRef.doc(userId)

  await userDocument.update({
    [fieldName]: value
  })
  .then(() => console.log("updated the doc"))
  .catch((e) => console.log(e))
}
const polly = new AWS.Polly({
  signatureVersion: 'v4',
  region: 'us-east-1'
});



app.post("/sendSupportMail", async (req, res) => {
  const { firstName, lastName, email, phoneNumber, message} = req.body;
  await sendSupportMail(firstName, lastName, email, phoneNumber, message);
  res.send("email sent")
})

app.post("/subscribeToLoop", async (req, res) => {
  const { email } = req.body;
  await registerEmailForLoopIntoDb(email)
  res.send()
});



app.post("/getAllSessions", async (req, res) => {
  const { userId } = req.body;
  const getAllSessionsForUser = await getAllUserSessions(userId);
  res.send({ sessions: getAllSessionsForUser})
})
app.post("/getSessionTranscripts", async (req, res) => {
  const { sessionId, userId } = req.body;
  const getAllTranscriptsForSessions = await getTextFromSummaryTable(userId, sessionId)
  res.send(getAllTranscriptsForSessions)
})
app.post("/chat", async (req, res) => {
  const { prompt, userId, sessionId } = req.body;
  await addTextData(userId, "user", prompt, ` [INST] ${prompt} [/INST]`, sessionId);
  const getData = await getTexts(userId, sessionId);

  let textResponse;
  console.log(getData)
  try {
    textResponse = await callAI(getData.aiLog)
    console.log(textResponse)
    await addTextData( userId, "assistant", textResponse, `${textResponse}`, sessionId)
  } catch (e){
    console.log(e)
  }

  console.log(getData)
  const params = {
    Text: `<speak><prosody rate="medium" volume="soft">` + textResponse + `</prosody></speak>`,
    TextType: "ssml",
    OutputFormat: "mp3",
    VoiceId: "Amy",
    Engine: "neural"
  };

  polly.synthesizeSpeech(params, (err, response) => {
    if (err) {
      console.error(err);
      res.status(500).send(err);
      return;
    }
    res.send(response.AudioStream);
  });
});

app.post("/dashboardData", async (req, res) => {
  const { userId } = req.body
  const getAllDashboardData = await getDashboardData(userId)
  res.send(getAllDashboardData)
});

app.post("/deleteEverythingForUser", async (req, res) => {
  const { userId } = req.body;
  await emailAllUserTranscripts(userId)
  await deleteAllUserSummaries(userId)
  res.send("finished")
})

app.post("/updateUserField", async (req, res) => {
  const { value, fieldName, userId } = req.body;
  await updateFieldInUserCollection(userId, value, fieldName)
  res.send()
})

const askForShortSummary = [
  {
    "role": "system",
    "content": "Give a category or a topic to this conversation in less than 4 words"
  }
];

const askForin5LongSummary = [
  {
    "role": "system",
    "content": "Summarize this conversation with 5 bullet points"
  }
]

const askForin3LongSummary = [
  {
    "role": "system",
    "content": "Summarize this conversation with 3 bullet points"
  }
]

app.post("/endSession", async (req, res) => {
  const { userId, sessionId } = req.body;
  const getData = await getTexts(userId, sessionId)
  const shortSummaryQuestion = getData.chatlog.concat(askForShortSummary)
  let longSummaryQuestion;
  if( getData.chatlog.length >= 10 ) {
    longSummaryQuestion = getData.chatlog.concat(askForin5LongSummary)
  } else {
    longSummaryQuestion = getData.chatlog.concat(askForin3LongSummary)
  }
  
  const analyzeUser = await getSentiment(userId, sessionId)
  const shortSummary = await callOpenAi(shortSummaryQuestion);
  const longSummary = await callOpenAi(longSummaryQuestion);

  console.log(shortSummary, "dsagadsgadgads")
  console.log(longSummary, "asdgandgoasdgoagadsg")

  const userMoodPercentage = moodTable[`${analyzeUser}`]

  await registerSummary(shortSummary, longSummary, userMoodPercentage, sessionId, userId, getData.chatlog)
  await deleteAllTexts(userId,sessionId)

  console.log({ chatlog: getData.chatlog, shortSummary: shortSummary, longSummary: longSummary, sessionId: sessionId, mood: userMoodPercentage })
  res.send({ chatlog: getData.chatlog, shortSummary: shortSummary, longSummary: longSummary, sessionId: sessionId, mood: userMoodPercentage })
})
const PORT = process.env.PORT || 8020;

callAI("[INST] hi [/INST]")
setInterval(() => { 
  callAI("[INST] hi [/INST]") 
  console.log("setInterval called the AI")
}, 30 * 60 * 1000)

app.listen(PORT, () => console.log(`Server running on port: ${PORT}`));