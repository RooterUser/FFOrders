import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";

export const firebaseConfig = {
    apiKey: "AIzaSyBtFfBweIhTgVu1w2GLJnsc62-RWKxRx7w",
    authDomain: "pvz-full.firebaseapp.com",
    projectId: "pvz-full",
    storageBucket: "pvz-full.firebasestorage.app",
    messagingSenderId: "245623016274",
    appId: "1:245623016274:web:28c54b7f75390d061a488b",
    measurementId: "G-27K24FMFCD"
};

// DEV-режим жестко ограничен локальной средой разработки и невозможен на продакшен-хосте
export const IS_LOCAL_PREVIEW = ["localhost", "127.0.0.1"].includes(window.location.hostname);

export const DEFAULT_TARIFFS = {
    boxFulfillmentPriceKopecks: 4500,
    boxCourierPayKopecks: 3000,
    itemCourierPayKopecks: 200,
    itemOzonRevenueKopecks: 1000
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);