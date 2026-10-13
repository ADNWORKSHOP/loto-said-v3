/*
 * Loto Votre Chance — règles du compte utilisateur (sans accès réseau).
 * Fonctionne dans le navigateur (window.AccountCore) et dans Node (require) pour les tests.
 * Le client Supabase reste dans index.html ; ce module décide seulement :
 *  - de l'état affiché (connecté, e-mail à confirmer, session expirée, non connecté) ;
 *  - de la réaction à chaque événement d'authentification ;
 *  - de la fusion entre données cloud et données locales, sans jamais perdre de données.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AccountCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATES = { SIGNED_IN: 'signed_in', UNCONFIRMED: 'email_unconfirmed', EXPIRED: 'expired', SIGNED_OUT: 'signed_out' };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function normalizeEmail(v) { return String(v || '').trim().toLowerCase(); }
  function isValidEmail(v) { const e = normalizeEmail(v); return e.length <= 254 && EMAIL_RE.test(e); }
  function cleanName(v) { return String(v || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80); }

  function profileFromUser(user) {
    if (!user) return null;
    const meta = user.user_metadata || {};
    return {
      id: user.id,
      email: normalizeEmail(user.email),
      firstName: cleanName(meta.first_name),
      lastName: cleanName(meta.last_name),
      emailConfirmed: !!(user.email_confirmed_at || user.confirmed_at)
    };
  }

  // expired : une session existait sur cet appareil et a été perdue sans déconnexion volontaire.
  function accountState(user, flags) {
    const f = flags || {};
    if (user) return profileFromUser(user).emailConfirmed ? STATES.SIGNED_IN : STATES.UNCONFIRMED;
    return f.expired ? STATES.EXPIRED : STATES.SIGNED_OUT;
  }

  /*
   * Réaction à un événement onAuthStateChange.
   *  load      : charger le profil et les données cloud
   *  update    : rafraîchir l'affichage du profil
   *  signedOut : déconnexion volontaire, effacer la copie locale
   *  expired   : session perdue (jeton expiré/révoqué) : conserver les données, proposer la reconnexion
   *  none      : rien à faire (évite les rechargements et les effacements parasites)
   */
  function authAction(event, ctx) {
    const c = ctx || {};
    switch (event) {
      case 'SIGNED_IN': return c.wasSignedIn && c.sameUser ? 'none' : 'load';
      case 'USER_UPDATED': return 'update';
      case 'PASSWORD_RECOVERY': return 'recovery';
      case 'SIGNED_OUT':
        if (c.voluntary) return 'signedOut';
        return c.wasSignedIn ? 'expired' : 'none';
      default: return 'none';
    }
  }

  function asList(v) { return Array.isArray(v) ? v : []; }

  /*
   * cloud     : contenu de user_app_data.data ou null si aucune ligne n'existe encore.
   * local     : { saved, played, pots } présents sur l'appareil.
   * localOwner: identifiant du compte à qui appartient la copie locale (null = invité).
   * Une ligne cloud existante fait foi. Sans ligne cloud, la copie locale de l'invité
   * ou du même compte est conservée et envoyée : rien n'est remis à zéro.
   */
  function mergeCloudState(cloud, local, localOwner, userId) {
    const l = local || {};
    if (cloud && typeof cloud === 'object') {
      return { state: { saved: asList(cloud.saved), played: asList(cloud.played), pots: asList(cloud.pots) }, needsPush: false, source: 'cloud' };
    }
    if (localOwner && localOwner !== userId) {
      return { state: { saved: [], played: [], pots: [] }, needsPush: false, source: 'empty' };
    }
    const state = { saved: asList(l.saved), played: asList(l.played), pots: asList(l.pots) };
    const hasData = state.saved.length + state.played.length + state.pots.length > 0;
    return { state: state, needsPush: hasData, source: hasData ? 'local' : 'empty' };
  }

  // Sauvegarde cloud autorisée seulement après un chargement réussi : un échec réseau
  // au démarrage ne doit jamais écraser les données du compte par une copie locale vide.
  function canPersist(ctx) { return !!(ctx && ctx.signedIn && ctx.cloudLoaded); }

  const PASSWORD_MIN = 8, PASSWORD_MAX = 72;
  // Renvoie '' si le mot de passe est acceptable, sinon un message à afficher.
  function passwordProblem(password, confirmation) {
    const p = String(password || '');
    if (p.length < PASSWORD_MIN) return 'Mot de passe trop court : ' + PASSWORD_MIN + ' caractères minimum.';
    if (p.length > PASSWORD_MAX) return 'Mot de passe trop long : ' + PASSWORD_MAX + ' caractères maximum.';
    if (!/[A-Za-zÀ-ÿ]/.test(p) || !/\d/.test(p)) return 'Mot de passe trop faible : utilisez au moins une lettre et un chiffre.';
    if (confirmation !== undefined && p !== String(confirmation || '')) return 'Les deux mots de passe ne correspondent pas.';
    return '';
  }

  function authErrorKind(error) {
    if (!error) return 'none';
    const code = String(error.code || ''), msg = String(error.message || '');
    if (error.name === 'AuthRetryableFetchError' || /failed to fetch|load failed|networkerror|network request failed/i.test(msg)) return 'network';
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'invalid_credentials';
    if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return 'email_not_confirmed';
    if (code === 'user_already_exists' || code === 'email_exists' || /already (been )?registered|already exists/i.test(msg)) return 'user_exists';
    if (code === 'same_password' || /different from the old/i.test(msg)) return 'same_password';
    if (code === 'weak_password' || /password should|weak password/i.test(msg)) return 'weak_password';
    if (/rate_limit/.test(code) || /rate limit|too many|security purposes/i.test(msg)) return 'rate_limit';
    if (code === 'session_not_found' || code === 'session_expired' || /auth session missing|session (not found|expired)|jwt expired/i.test(msg)) return 'session';
    if (code === 'otp_expired' || /link is invalid or has expired|token has expired/i.test(msg)) return 'link_expired';
    if (code === 'signup_disabled' || /signups? not allowed/i.test(msg)) return 'signup_disabled';
    if (code === 'email_address_invalid' || /email address .*invalid/i.test(msg)) return 'email_invalid';
    if (/redirect/i.test(msg)) return 'redirect';
    return 'unknown';
  }

  const ERROR_MESSAGES = {
    network: 'Connexion internet indisponible. Vérifiez le réseau puis réessayez : rien n’a été perdu.',
    invalid_credentials: 'E-mail ou mot de passe incorrect. Compte créé avec un lien sans mot de passe ? Utilisez « Mot de passe oublié ».',
    email_not_confirmed: 'Adresse e-mail pas encore confirmée : appuyez sur le lien reçu par e-mail, ou renvoyez-le ci-dessous.',
    user_exists: 'Un compte existe déjà avec cette adresse. Connectez-vous, ou utilisez « Mot de passe oublié ».',
    same_password: 'Le nouveau mot de passe doit être différent de l’ancien.',
    weak_password: 'Mot de passe refusé car trop faible : allongez-le et mélangez lettres et chiffres.',
    rate_limit: 'Trop de demandes rapprochées : le service d’e-mails limite les envois. Patientez quelques minutes avant de réessayer.',
    session: 'Session expirée. Reconnectez-vous pour continuer : vos données sont conservées.',
    link_expired: 'Lien expiré ou déjà utilisé. Si votre adresse est déjà confirmée, connectez-vous simplement ; sinon, demandez un nouvel e-mail.',
    signup_disabled: 'La création de compte est désactivée pour le moment.',
    email_invalid: 'Adresse e-mail refusée : vérifiez qu’elle est correcte.',
    redirect: 'Adresse de retour refusée par Supabase : ajoutez l’URL de l’application dans Authentication > URL Configuration.'
  };
  function authErrorMessage(error) {
    const kind = authErrorKind(error);
    return ERROR_MESSAGES[kind] || ('Erreur : ' + (String((error && error.message) || '') || 'opération impossible.'));
  }

  // Avec la confirmation e-mail activée, Supabase répond sans erreur pour une adresse déjà
  // utilisée (anti-énumération) mais avec une liste d'identités vide.
  function isExistingAccountSignup(data) {
    const u = data && data.user;
    return !!(u && Array.isArray(u.identities) && u.identities.length === 0);
  }

  // Lecture des paramètres laissés dans l'URL par un lien e-mail Supabase (flux implicit).
  function parseAuthRedirect(hash, search) {
    const h = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const get = (k) => h.get(k) || q.get(k) || '';
    const error = get('error_code') || get('error');
    return {
      present: !!(get('access_token') || error || get('error_description') || get('token_hash')),
      type: get('type'),
      error: error,
      errorDescription: get('error_description')
    };
  }

  function redirectErrorMessage(r) {
    const d = (r && r.errorDescription) || '';
    if (!r || r.error === 'otp_expired' || /expired|invalid/i.test(d)) return ERROR_MESSAGES.link_expired;
    return 'Lien refusé : ' + (d || r.error) + '. Demandez un nouvel e-mail.';
  }

  return {
    STATES: STATES,
    PASSWORD_MIN: PASSWORD_MIN,
    PASSWORD_MAX: PASSWORD_MAX,
    normalizeEmail: normalizeEmail,
    isValidEmail: isValidEmail,
    cleanName: cleanName,
    passwordProblem: passwordProblem,
    profileFromUser: profileFromUser,
    accountState: accountState,
    authAction: authAction,
    mergeCloudState: mergeCloudState,
    canPersist: canPersist,
    authErrorKind: authErrorKind,
    authErrorMessage: authErrorMessage,
    isExistingAccountSignup: isExistingAccountSignup,
    parseAuthRedirect: parseAuthRedirect,
    redirectErrorMessage: redirectErrorMessage
  };
});
