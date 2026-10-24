export const SOUND_SOURCES = {
  shuffle: "/assets/audio/sfx/card-shuffle.mp3",
  cardFlip: "/assets/audio/sfx/card-flip.ogg",
  blackjack: "/assets/audio/sfx/blackjack.ogg",
  naturalBlackjack: "/assets/audio/sfx/natural-blackjack.ogg",
  bust: "/assets/audio/sfx/bust.ogg",
  compare: "/assets/audio/sfx/compare.ogg",
  result: "/assets/audio/sfx/result.ogg",
  stand: "/assets/audio/sfx/stand.ogg",
  skillDraw: "/assets/audio/sfx/skill-draw.ogg",
  skillAcquire: "/assets/audio/sfx/skill-acquire.ogg",
  /** Dedicated routing key; replace this asset when the final skill-use SFX is available. */
  skillUse: "/assets/audio/sfx/stand.ogg",
  heartbeat: "/assets/audio/sfx/heartbeat.ogg",
  dryFire: "/assets/audio/sfx/revolver-dry-fire.ogg",
  /** Dedicated routing key; replace this asset when the final misfire SFX is available. */
  misfire: "/assets/audio/sfx/revolver-dry-fire.ogg",
  gunshot: "/assets/audio/sfx/revolver-gunshot.ogg"
} as const;

export type SoundCue = keyof typeof SOUND_SOURCES;

export const SOUND_VOLUME: Readonly<Record<SoundCue, number>> = {
  shuffle: 0.56,
  cardFlip: 0.62,
  blackjack: 0.66,
  naturalBlackjack: 0.62,
  bust: 0.7,
  compare: 0.64,
  result: 0.74,
  stand: 0.76,
  skillDraw: 0.76,
  skillAcquire: 0.76,
  skillUse: 0.76,
  heartbeat: 0.34,
  dryFire: 0.72,
  misfire: 0.72,
  gunshot: 0.78
};
