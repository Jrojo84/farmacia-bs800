// Función del servidor: el administrador pone una contraseña temporal a un usuario.
// Una página web no puede cambiar la contraseña de otra persona; por eso vive aquí.
// Instalar: ver LEEME.md, paso 6.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

// Debe coincidir con el administrador de js/config.js y firestore.rules
const CORREO_ADMIN = "admin@farmacia.app";

exports.restablecerClave = onCall(async (req) => {
  if (req.auth?.token?.email !== CORREO_ADMIN) {
    throw new HttpsError("permission-denied", "Solo el administrador puede restablecer contraseñas");
  }
  const { uid, clave } = req.data || {};
  if (typeof uid !== "string" || typeof clave !== "string" || clave.length < 6) {
    throw new HttpsError("invalid-argument", "Datos inválidos");
  }
  await admin.auth().updateUser(uid, { password: clave });
  // Al ingresar, la app le pedirá crear una contraseña nueva
  await admin.firestore().doc(`usuarios/${uid}`).set({ claveTemporal: true }, { merge: true });
  return { ok: true };
});
