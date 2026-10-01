import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { repositoryRoot, routes } from '../model.mjs';

export const collections = {
  docs: defineCollection({
    loader: glob({ base: repositoryRoot, pattern: Object.keys(routes), generateId: ({ entry }) => entry }),
  }),
};
