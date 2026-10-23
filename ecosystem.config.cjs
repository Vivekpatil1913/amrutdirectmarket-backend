// PM2 process file:  pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: "amrit-peth-api",
      script: "src/server.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: "400M",
      env: { NODE_ENV: "production" },
    },
  ],
};
