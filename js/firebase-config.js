// Firebase compat version (no modules)
const firebaseConfig = {
  apiKey: "",
  authDomain: "novaxaii.firebaseapp.com",
  projectId: "novaxaii",
  storageBucket: "novaxaii.firebasestorage.app",
  messagingSenderId: "1025503656557",
  appId: "1:1025503656557:web:a09d13f47afe1b25c3dd64"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();
