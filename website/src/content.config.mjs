import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { repositoryRoot } from '../model.mjs';
import { publications } from '../publication.mjs';
export const collections = {
  docs: defineCollection({ loader: glob({ base: repositoryRoot, pattern: Object.keys(publications), generateId: ({ entry }) => entry }) }),
};
