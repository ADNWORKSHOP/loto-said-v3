'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/account.js');

const confirmedUser = { id: 'u1', email: ' Said@Exemple.FR ', email_confirmed_at: '2026-10-01T10:00:00Z', user_metadata: { first_name: 'Saïd', last_name: 'Z' } };

test('profil lu depuis le compte, e-mail normalisé', () => {
  const p = A.profileFromUser(confirmedUser);
  assert.deepEqual(p, { id: 'u1', email: 'said@exemple.fr', firstName: 'Saïd', lastName: 'Z', emailConfirmed: true });
  assert.equal(A.profileFromUser(null), null);
});

test('états du compte', () => {
  assert.equal(A.accountState(confirmedUser), 'signed_in');
  assert.equal(A.accountState({ id: 'u2', email: 'a@b.fr' }), 'email_unconfirmed');
  assert.equal(A.accountState(null, { expired: true }), 'expired');
  assert.equal(A.accountState(null), 'signed_out');
});

test('événements : pas de rechargement ni d’effacement parasite', () => {
  assert.equal(A.authAction('INITIAL_SESSION', { wasSignedIn: true }), 'none');
  assert.equal(A.authAction('TOKEN_REFRESHED', { wasSignedIn: true }), 'none');
  assert.equal(A.authAction('SIGNED_IN', { wasSignedIn: true, sameUser: true }), 'none');
  assert.equal(A.authAction('SIGNED_IN', { wasSignedIn: false }), 'load');
  assert.equal(A.authAction('SIGNED_IN', { wasSignedIn: true, sameUser: false }), 'load');
  assert.equal(A.authAction('USER_UPDATED', {}), 'update');
});

test('déconnexion volontaire vs session perdue', () => {
  assert.equal(A.authAction('SIGNED_OUT', { voluntary: true, wasSignedIn: true }), 'signedOut');
  assert.equal(A.authAction('SIGNED_OUT', { voluntary: false, wasSignedIn: true }), 'expired');
  assert.equal(A.authAction('SIGNED_OUT', { voluntary: false, wasSignedIn: false }), 'none');
});

test('fusion : la ligne cloud fait foi', () => {
  const r = A.mergeCloudState({ saved: [1], played: [2], pots: 'x' }, { saved: [9] }, 'u1', 'u1');
  assert.deepEqual(r, { state: { saved: [1], played: [2], pots: [] }, needsPush: false, source: 'cloud' });
});

test('fusion : premier chargement sans ligne cloud conserve les grilles locales', () => {
  const r = A.mergeCloudState(null, { saved: [{ nums: [1, 2, 3, 4, 5] }], played: [], pots: [] }, null, 'u1');
  assert.equal(r.source, 'local');
  assert.equal(r.needsPush, true);
  assert.equal(r.state.saved.length, 1);
});

test('fusion : la copie locale d’un autre compte n’est jamais transférée', () => {
  const r = A.mergeCloudState(null, { saved: [{ id: 1 }] }, 'autre', 'u1');
  assert.deepEqual(r.state, { saved: [], played: [], pots: [] });
  assert.equal(r.needsPush, false);
});

test('aucune sauvegarde cloud avant un chargement réussi', () => {
  assert.equal(A.canPersist({ signedIn: true, cloudLoaded: false }), false);
  assert.equal(A.canPersist({ signedIn: false, cloudLoaded: true }), false);
  assert.equal(A.canPersist({ signedIn: true, cloudLoaded: true }), true);
});

test('validation des saisies', () => {
  assert.equal(A.isValidEmail('a@b.fr'), true);
  assert.equal(A.isValidEmail('pas-un-email'), false);
  assert.equal(A.cleanName('  <b>Jean</b>   Paul '), 'bJean/b Paul');
});

test('messages d’erreur compréhensibles', () => {
  assert.equal(A.authErrorKind({ code: 'invalid_credentials', message: 'Invalid login credentials' }), 'invalid_credentials');
  assert.match(A.authErrorMessage({ message: 'Invalid login credentials' }), /Mot de passe oublié/);
  assert.match(A.authErrorMessage({ code: 'email_not_confirmed' }), /lien/);
  assert.match(A.authErrorMessage({ message: 'User already registered' }), /existe déjà/);
  assert.match(A.authErrorMessage({ message: 'email rate limit exceeded' }), /Patientez/);
  assert.match(A.authErrorMessage({ name: 'AuthRetryableFetchError', message: 'Load failed' }), /internet/);
  assert.match(A.authErrorMessage({ message: 'Auth session missing!' }), /Session expirée/);
  assert.match(A.authErrorMessage({ code: 'same_password' }), /différent/);
  assert.match(A.authErrorMessage({ message: 'bizarre' }), /^Erreur : bizarre/);
});

test('mot de passe : règles locales avant envoi', () => {
  assert.match(A.passwordProblem('abc1'), /trop court/);
  assert.match(A.passwordProblem('abcdefgh'), /faible/);
  assert.match(A.passwordProblem('abcdefg1', 'abcdefg2'), /correspondent/);
  assert.equal(A.passwordProblem('Chance2026', 'Chance2026'), '');
});

test('inscription : adresse déjà utilisée détectée', () => {
  assert.equal(A.isExistingAccountSignup({ user: { id: 'x', identities: [] } }), true);
  assert.equal(A.isExistingAccountSignup({ user: { id: 'x', identities: [{ id: 1 }] } }), false);
  assert.equal(A.isExistingAccountSignup({ user: null }), false);
});

test('retour de lien e-mail : confirmation, réinitialisation, lien déjà utilisé', () => {
  const ok = A.parseAuthRedirect('#access_token=abc&refresh_token=r&type=signup', '');
  assert.equal(ok.present, true); assert.equal(ok.type, 'signup'); assert.equal(ok.error, '');
  assert.equal(A.parseAuthRedirect('#access_token=abc&type=recovery', '').type, 'recovery');
  const used = A.parseAuthRedirect('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', '');
  assert.equal(used.error, 'otp_expired');
  assert.match(A.redirectErrorMessage(used), /déjà utilisé/);
  assert.equal(A.parseAuthRedirect('', '?page=home').present, false);
  assert.equal(A.authAction('PASSWORD_RECOVERY', {}), 'recovery');
});

// Simulation d'un cycle complet avec un faux client (sans réseau) :
// création, fermeture/réouverture, expiration, reconnexion sur le même compte.
test('scénario simulé : la réouverture restaure le même compte et ses données', () => {
  const storage = new Map();
  const cloud = new Map();
  const persistSession = (user) => storage.set('session', JSON.stringify(user));
  const restoreSession = () => (storage.has('session') ? JSON.parse(storage.get('session')) : null);

  persistSession(confirmedUser);
  cloud.set('u1', { saved: [{ nums: [3, 9, 17, 28, 41] }], played: [], pots: [] });

  const reopened = restoreSession();
  assert.equal(A.accountState(reopened), 'signed_in');
  assert.equal(A.profileFromUser(reopened).firstName, 'Saïd');
  const merged = A.mergeCloudState(cloud.get(reopened.id), { saved: [] }, 'u1', reopened.id);
  assert.equal(merged.state.saved.length, 1);

  storage.delete('session');
  assert.equal(A.authAction('SIGNED_OUT', { voluntary: false, wasSignedIn: true }), 'expired');
  assert.equal(A.accountState(restoreSession(), { expired: true }), 'expired');

  persistSession(confirmedUser);
  const again = A.mergeCloudState(cloud.get('u1'), { saved: [{ nums: [3, 9, 17, 28, 41] }] }, 'u1', 'u1');
  assert.equal(again.source, 'cloud');
  assert.equal(again.state.saved.length, 1);
});
