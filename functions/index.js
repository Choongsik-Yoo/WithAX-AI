import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';

initializeApp();
const region = 'asia-northeast3';
const auth = getAuth();
const validRoles = ['employee', 'evaluator', 'admin', 'approver'];

function rolesFor(entry) {
  if (entry?.active !== true || !Array.isArray(entry.roles)) return [];
  if (entry.roles.some(role => !validRoles.includes(role))) return [];
  return [...new Set(entry.roles)];
}

async function syncClaims(uid, roles) {
  const user = await auth.getUser(uid);
  const claims = user.customClaims ?? {};
  if (JSON.stringify(claims.roles ?? []) !== JSON.stringify(roles)) {
    await auth.setCustomUserClaims(uid, { ...claims, roles });
  }
}

export const access = onCall({ region }, async request => {
  const user = request.auth;
  const email = user?.token.email;
  if (!email || user.token.email_verified !== true || user.token.firebase.sign_in_provider !== 'google.com') {
    throw new HttpsError('permission-denied', '확인된 Google 계정으로 로그인하세요.');
  }
  const entry = await getFirestore().collection('allowlist').doc(email.toLowerCase()).get();
  const roles = rolesFor(entry.data());
  if (!roles.length) throw new HttpsError('permission-denied', '등록되지 않은 계정입니다. 관리자에게 문의하세요.');
  await syncClaims(user.uid, roles);
  return { roles };
});

export const updateRoles = onDocumentWritten({ region, document: 'allowlist/{email}', retry: true }, async event => {
  const email = event.params.email;
  const user = await auth.getUserByEmail(email).catch(error => {
    if (error.code === 'auth/user-not-found') return null;
    throw error;
  });
  if (!user) return;
  const current = await getFirestore().collection('allowlist').doc(email).get();
  const roles = rolesFor(current.data());
  await syncClaims(user.uid, roles);
  if (!roles.length) await auth.revokeRefreshTokens(user.uid);
});
