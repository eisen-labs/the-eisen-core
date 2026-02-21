import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://eisenlabs.com',
      lastModified: new Date(),
      priority: 1,
    },
  ];
}
