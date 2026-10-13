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
  // Supabase envoie un code à 6 chiffres par défaut (jusqu'à 10 selon la configuration).
  function isValidOtpCode(v) { return /^\d{6,10}$/.test(String(v || '').replace(/\s/g, '')); }

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

  function signInErrorMessage(error, mode) {
    const msg = String((error && error.message) || '');
    if (/signups? not allowed|user not found|otp_disabled/i.test(msg) && mode === 'signin') {
      return 'Aucun compte n’existe pour cette adresse. Choisissez « Créer un compte ».';
    }
    if (/rate limit|too many|security purposes/i.test(msg)) {
      return 'Trop de demandes rapprochées. Patientez une minute avant de redemander un e-mail.';
    }
    if (/redirect/i.test(msg)) return 'Adresse de retour refusée par Supabase : ajoutez cette URL dans Authentication > URL Configuration.';
    return 'Erreur : ' + (msg || 'envoi impossible.');
  }

  function verifyErrorMessage(error) {
    const msg = String((error && error.message) || '');
    if (/expired|invalid/i.test(msg)) return 'Code invalide ou expiré. Demandez un nouvel e-mail.';
    return 'Erreur : ' + (msg || 'vérification impossible.');
  }

  return {
    STATES: STATES,
    normalizeEmail: normalizeEmail,
    isValidEmail: isValidEmail,
    cleanName: cleanName,
    isValidOtpCode: isValidOtpCode,
    profileFromUser: profileFromUser,
    accountState: accountState,
    authAction: authAction,
    mergeCloudState: mergeCloudState,
    canPersist: canPersist,
    signInErrorMessage: signInErrorMessage,
    verifyErrorMessage: verifyErrorMessage
  };
});
