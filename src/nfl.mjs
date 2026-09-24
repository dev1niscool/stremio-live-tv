const TOKEN_EDGE = '[^\\p{L}\\p{N}]';
const NFL_TEAMS_GROUP = new RegExp(`(?:^|${TOKEN_EDGE})nfl${TOKEN_EDGE}+teams(?=$|${TOKEN_EDGE})`, 'u');
const NFL_SIGNAL = new RegExp(
  `(?:^|${TOKEN_EDGE})(?:nfl[0-9]*|red${TOKEN_EDGE}*zone|sunday${TOKEN_EDGE}+ticket|national${TOKEN_EDGE}+football${TOKEN_EDGE}+league)(?=$|${TOKEN_EDGE})`,
  'u',
);

function normalize(value) {
  return typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : '';
}

/**
 * Identify NFL-specific feeds among channels that already passed the strict live
 * parser. This is a content filter, not an alternative live/VOD classifier.
 */
export function isNflChannel(channel) {
  const group = normalize(channel?.group);
  // This provider's "NFL Teams" group consists of general local FOX/CBS/NBC/ABC
  // affiliates. Exclude the entire group even when an individual name says NFL,
  // because those affiliates carry broad programming outside NFL broadcasts.
  if (NFL_TEAMS_GROUP.test(group)) return false;
  return NFL_SIGNAL.test(group) || NFL_SIGNAL.test(normalize(channel?.name));
}
