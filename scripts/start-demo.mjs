process.env.DEMO_MODE = 'true';
process.env.NODE_ENV ||= 'production';

await import('../server/dist/index.js');
