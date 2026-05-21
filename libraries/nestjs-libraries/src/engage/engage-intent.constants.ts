export const INTENT_LABELS = [
  'help_seeking',  // 求助型：含 ? + how/help/anyone
  'rant',          // 吐槽型：frustrated/hate/tired of/so annoying
  'discussion',    // 讨论型：开放性陈述 + thoughts?/what do you think
  'opinion',       // 观点型：I think/hot take/unpopular opinion
  'comparison',    // 比较型：vs/compare/better than/alternative
  'data_share',    // 数据分享：数字/% + found/report/study
] as const;

export type IntentLabel = (typeof INTENT_LABELS)[number];

// primaryIntent → default recommended reply strategy
export const INTENT_DEFAULT_STRATEGY: Record<IntentLabel, string> = {
  help_seeking: 'EXPERT_ANSWER',
  rant: 'EMPATHY_LED',
  discussion: 'EXPERT_ANSWER',
  opinion: 'DATA_BACKED',
  comparison: 'DATA_BACKED',
  data_share: 'DATA_BACKED',
};
