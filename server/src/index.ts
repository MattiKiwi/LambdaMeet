import http from "http";
import express from "express";
import cors from "cors";
import router from "./routes.js";
import { env } from "./config.js";
import { startSignaling } from "./signaling.js";
import { actionStart, actionSuccess, logger, withComponent } from "./logger.js";
import { disconnectCache, initCache } from "./cache.js";

const app = express();
const log = withComponent("api");

app.use(
  cors({
    origin: env.corsOrigin || "*",
  })
);

app.use((req, res, next) => {
  const meta = { method: req.method, url: req.url };
  actionStart("api", "request", meta);
  res.on("finish", () => {
    actionSuccess("api", "request", { ...meta, status: res.statusCode });
  });
  next();
});

app.use("/api", router);

const server = http.createServer(app);
startSignaling(server);
initCache();

server.listen(env.port, env.host, () => {
  logger.info({ step: "startup" }, `Server listening on http://${env.host}:${env.port}`);
});

process.on("SIGINT", async () => {
  actionStart("api", "shutdown");
  await disconnectCache();
  actionSuccess("api", "shutdown");
  process.exit(0);
});
