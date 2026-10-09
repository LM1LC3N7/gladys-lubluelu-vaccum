// -----------------------------------------------------------------------------
// User-facing texts, in the two languages this integration ships (en, fr).
//
// Where each text ends up decides where its language comes from:
//   - feature names and select option labels are plain strings frozen when
//     the device is created in Gladys (the core stores no translation): they
//     follow the `language` config field, since a device integration never
//     learns the user's language;
//   - widget contents receive the requesting user's language with every
//     request (onWidgetGet), so they always match the person looking;
//   - scene event variables (an error message) follow the config field too.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['fr', 'en'];
export const DEFAULT_LANGUAGE = 'fr';

/** `fr` or `en`, whatever comes in. */
export function languageOf(value) {
  return value === 'en' ? 'en' : value === 'fr' ? 'fr' : DEFAULT_LANGUAGE;
}

/** Pick one language out of a `{ en, fr }` pair. */
export function pick(pair, language) {
  if (pair === undefined || pair === null || typeof pair !== 'object') {
    return pair;
  }
  return pair[languageOf(language)] ?? pair.en;
}

export const FEATURE_NAMES = {
  power: { en: 'Power', fr: 'Marche' },
  pause: { en: 'Pause', fr: 'Pause' },
  state: { en: 'State', fr: 'État' },
  mode: { en: 'Mode', fr: 'Mode' },
  cistern: { en: 'Water level', fr: "Débit d'eau" },
  suction: { en: 'Suction power', fr: "Puissance d'aspiration" },
  battery: { en: 'Battery', fr: 'Batterie' },
  fault: { en: 'Fault code', fr: 'Code de défaut' },
  seek: { en: 'Find robot', fr: 'Localiser le robot' },
  dock: { en: 'Return to dock', fr: 'Retour à la base' },
  clean_area: { en: 'Cleaned area', fr: 'Surface nettoyée' },
  clean_time: { en: 'Cleaning time', fr: 'Durée de nettoyage' },
  total_clean_area: { en: 'Total cleaned area', fr: 'Surface nettoyée (total)' },
  total_clean_time: { en: 'Total cleaning time', fr: 'Durée de nettoyage (total)' },
  roll_brush: { en: 'Roll brush', fr: 'Brosse principale' },
  edge_brush: { en: 'Side brush', fr: 'Brosse latérale' },
  filter: { en: 'Filter', fr: 'Filtre' },
  duster_cloth: { en: 'Mop pad', fr: 'Serpillière' },
  reset_roll_brush: { en: 'Reset roll brush', fr: 'Réinitialiser la brosse principale' },
  reset_edge_brush: { en: 'Reset side brush', fr: 'Réinitialiser la brosse latérale' },
  reset_filter: { en: 'Reset filter', fr: 'Réinitialiser le filtre' },
  reset_duster_cloth: { en: 'Reset mop pad', fr: 'Réinitialiser la serpillière' },
  switch_disturb: { en: 'Do not disturb', fr: 'Ne pas déranger' },
  zone: { en: 'Zone', fr: 'Zone' },
};

// Labels for enum values this integration recognizes across brands (Tuya's
// `values.range` only carries the raw machine tokens).
export const MODE_LABELS = {
  smart: { en: 'Smart', fr: 'Intelligent' },
  auto: { en: 'Smart', fr: 'Intelligent' },
  wall_follow: { en: 'Along walls', fr: 'Le long des murs' },
  spot: { en: 'Spot', fr: 'Zone ciblée' },
  spiral: { en: 'Spiral', fr: 'Spirale' },
  single: { en: 'Single room', fr: 'Pièce unique' },
  selectroom: { en: 'Selected rooms', fr: 'Pièces choisies' },
  zone: { en: 'Zone', fr: 'Zone' },
  part: { en: 'Area', fr: 'Partie' },
  pose: { en: 'Point', fr: 'Point' },
  chargego: { en: 'Return to dock', fr: 'Retour à la base' },
  standby: { en: 'Standby', fr: 'Veille' },
  pause: { en: 'Paused', fr: 'En pause' },
  mop: { en: 'Mopping', fr: 'Serpillière' },
  left_spiral: { en: 'Spiral (left)', fr: 'Spirale (gauche)' },
  right_spiral: { en: 'Spiral (right)', fr: 'Spirale (droite)' },
};

export const CISTERN_LABELS = {
  closed: { en: 'Off', fr: 'Coupé' },
  low: { en: 'Low', fr: 'Faible' },
  middle: { en: 'Medium', fr: 'Moyen' },
  high: { en: 'High', fr: 'Élevé' },
};

export const SUCTION_LABELS = {
  closed: { en: 'Off', fr: 'Coupée' },
  gentle: { en: 'Quiet', fr: 'Silencieux' },
  quiet: { en: 'Quiet', fr: 'Silencieux' },
  normal: { en: 'Normal', fr: 'Normal' },
  strong: { en: 'Strong', fr: 'Puissant' },
  high: { en: 'Strong', fr: 'Puissant' },
  max: { en: 'Max', fr: 'Maximum' },
  boost_iq: { en: 'Boost', fr: 'Boost' },
};

/** Gladys VACUUM_CLEANER.STATE values (server/utils/constants.js). */
export const STATE_LABELS = [
  { en: 'Stopped', fr: 'Arrêté' },
  { en: 'Cleaning', fr: 'En nettoyage' },
  { en: 'Paused', fr: 'En pause' },
  { en: 'Error', fr: 'En erreur' },
  { en: 'Returning to dock', fr: 'Retour à la base' },
  { en: 'Charging', fr: 'En charge' },
  { en: 'Docked', fr: 'Sur la base' },
];

// Bits of the Tuya `fault` bitmap, as the robot-vacuum category names them
// (the schema's own `values.label` list wins when the device reports one).
export const FAULT_LABELS = {
  edge_sweep: { en: 'Side brush', fr: 'Brosse latérale' },
  middle_sweep: { en: 'Roll brush', fr: 'Brosse principale' },
  left_wheel: { en: 'Left wheel', fr: 'Roue gauche' },
  right_wheel: { en: 'Right wheel', fr: 'Roue droite' },
  garbage_box: { en: 'Dust bin', fr: 'Bac à poussière' },
  land_check: { en: 'Cliff sensor', fr: 'Capteur de vide' },
  collision: { en: 'Bumper', fr: 'Pare-chocs' },
  stuck: { en: 'Stuck', fr: 'Bloqué' },
  low_power: { en: 'Low battery', fr: 'Batterie faible' },
  water_tank: { en: 'Water tank', fr: "Réservoir d'eau" },
  lidar: { en: 'LiDAR', fr: 'LiDAR' },
};

export const TEXTS = {
  unknownDevice: { en: 'Tuya vacuum', fr: 'Aspirateur Tuya' },
  fault: { en: 'Fault', fr: 'Défaut' },
  unknownFault: { en: (code) => `Fault ${code}`, fr: (code) => `Défaut ${code}` },
};
