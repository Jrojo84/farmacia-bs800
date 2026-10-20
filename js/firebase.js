// Carga Firebase real, o la simulación local (js/demo.js) si config.js aún no tiene los datos del proyecto.
import { firebaseConfig } from "./config.js";

export const DEMO = firebaseConfig.apiKey === "PEGAR_AQUI";

async function cargarFirebase() {
  const base = "https://www.gstatic.com/firebasejs/10.12.2/";
  const mods = await Promise.all(["firebase-app.js", "firebase-auth.js", "firebase-firestore.js", "firebase-functions.js", "firebase-app-check.js"].map((f) => import(base + f)));
  return Object.assign({}, ...mods);
}

const fb = DEMO ? await import("./demo.js") : await cargarFirebase();

export const {
  initializeApp, getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword, updatePassword,
  getFunctions, httpsCallable,
  initializeFirestore, getFirestore, persistentLocalCache, collection, doc, getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, runTransaction, writeBatch, serverTimestamp, Timestamp,
} = fb;

export const reiniciarDemo = fb.reiniciarDemo || (() => {});

// App Check (solo con Firebase real): demuestra que la petición viene de esta página
export const activarAppCheck = (app, claveSitio) => {
  if (DEMO || !claveSitio) return;
  fb.initializeAppCheck(app, { provider: new fb.ReCaptchaV3Provider(claveSitio), isTokenAutoRefreshEnabled: true });
};
