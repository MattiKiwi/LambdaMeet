import http from "http";
import express from "express";
import cors from "cors";
import router from "./routes.js";
import { env } from "./config.js";
import { startSignaling } from "./signaling.js";
import { logger, withComponent } from "./logger.js";

const app = express();
const log = withComponent("api");

app.use(
  cors({
    origin: env.corsOrigin || "*",
  })
);

app.use((req, _res, next) => {
  log.debug({ step: "request", method: req.method, url: req.url });
  next();
});

app.use("/api", router);

const server = http.createServer(app);
startSignaling(server);

server.listen(env.port, env.host, () => {
  logger.info({ step: "startup" }, `Server listening on http://${env.host}:${env.port}`);
});
