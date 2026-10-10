// The prepared library scenes' prompts and routing, without their content.
// `scenes.ts` holds the answers and loads with the library on first use.
export const sceneIndex = {
  ships: { prompt: 'What happened to the twelve ships?', title: 'The twelve ships', match: /twelve ships|\bships\b/i },
  stores: { prompt: 'How fast are the estate stores going?', title: 'The estate stores', match: /stores|estate|drawdown/i },
  voyage: { prompt: 'Show the voyage so far.', title: 'The voyage so far', match: /voyage so far|whole voyage|every leg/i },
  losses: { prompt: 'Where was each man lost?', title: 'Where the crew were lost', match: /lost|losses|each man/i },
  suitors: { prompt: 'Who is in the hall at Ithaca?', title: 'The hall at Ithaca', match: /suitor|in the hall/i },
  dead: { prompt: 'What did the dead tell me?', title: 'At the house of the dead', match: /the dead|shades|acheron/i },
  steer: { prompt: 'How do I steer to Scheria?', title: 'Steering to Scheria', match: /steer|scheria|heading|great bear/i },
  week: { prompt: 'What did I write this week?', title: 'This week in the journal', match: /this week|journal|did i write/i },
} satisfies Record<string, { prompt: string; title: string; match: RegExp }>;
export type SceneId = keyof typeof sceneIndex;
