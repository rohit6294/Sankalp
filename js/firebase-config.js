const firebaseConfig = {
  apiKey: "AIzaSyCalURtPJ-TIIEvhTVcBQ373wkILxSSxVo",
  authDomain: "sankalp-learning-5442f.firebaseapp.com",
  projectId: "sankalp-learning-5442f",
  storageBucket: "sankalp-learning-5442f.firebasestorage.app",
  messagingSenderId: "60342126146",
  appId: "1:60342126146:web:50b2f53719da5de64e4fdb",
  measurementId: "G-NJBYC84GDR"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

// Evaluator API base URL (update after deploying to Render)
window.EVALUATOR_API = 'http://localhost:3000';
