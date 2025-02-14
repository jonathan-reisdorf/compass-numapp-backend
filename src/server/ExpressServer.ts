/*
 * Copyright (c) 2021, IBM Deutschland GmbH
 */
import * as bodyParser from 'body-parser';
import * as dotenv from 'dotenv';
import { Request, Response } from 'express';

import { HealthChecker, HealthEndpoint } from '@cloudnative/health-connect';
import { Server } from '@overnightjs/core';
import { Logger } from '@overnightjs/logger';

import { Environment } from '../config/Environment';
import * as controllers from '../controllers';
import { CustomRoutes } from './CustomRoutes';
import DB from './DB';
import { Route } from './Route';
import { SwaggerUI } from './SwaggerUI';

/**
 * This class has all the logic to setup express to our needs.
 *
 * @class ExpressServer
 * @extends {Server}
 */
class ExpressServer extends Server {
    constructor() {
        super(Environment.isLocal()); // setting showLogs to true for development

        if (Environment.isLocal()) {
            Logger.Imp('Server starting in environment: local/development');
            const result = dotenv.config({ path: './.env' });
            if (result.error) {
                Logger.Err(result.error);
                throw result.error;
            }
        }

        if (Environment.isProd()) {
            Logger.Imp('Server starting in environment: production');
            Logger.Info('Server not local. Setting up proxy ...');
            this.app.enable('trust proxy');
        }

        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));

        this.setupControllers();
    }

    private setupControllers(): void {
        const ctrlInstances = [];
        for (const name in controllers) {
            // eslint-disable-next-line no-prototype-builtins
            if (controllers.hasOwnProperty(name)) {
                const controller = controllers[name];
                ctrlInstances.push(new controller());
            }
        }
        super.addControllers(ctrlInstances);
    }

    /**
     * The start methods. It performs following steps
     * - Startup express server
     * - Open a DB connection
     * - Create a health endpoint for probing
     * - Start Swagger UI for API documentation
     *
     * In case of issues, like failing DB connection, this method exits the running process.
     *
     * @param {number} port The port number to use.
     * @memberof ExpressServer
     */
    public start(port: number): void {
        DB.initPool(
            async (conn: string) => {
                Logger.Info(`${conn} connection successful.`);

                // initialize swagger ui
                const swaggerUI: SwaggerUI = new SwaggerUI(this.app);
                await swaggerUI.start();

                // setup cloud health endpoints
                const healthCheck = new HealthChecker();
                this.app.use('/health', HealthEndpoint(healthCheck));
                CustomRoutes.addRoute('GET', '/health');

                this.logRegisteredRoutes();
                this.startExpressApp(port);
            },
            (conn: string, err: Error) => {
                Logger.Err(`Failed to establish ${conn} connection. Did the network just go down?`);
                Logger.Err(err);
                return process.exit(1);
            }
        );
    }

    private startExpressApp(port: number): void {
        this.app.use('/api/*', this.deactivateCaching);

        // catch 404 and forward to error handler
        this.app.use((req: Request, res: Response) => {
            res.status(404).json({
                error: "Route '" + req.url + "' not found."
            });
        });

        this.app.listen(port, () => {
            Logger.Imp(`Express server started on port: ${port}`);
        });
    }

    private deactivateCaching(req: Request, res: Response, next: VoidFunction): void {
        if (req.method === 'GET') {
            res.header('Cache-Control', 'private, max-age=1');
        } else {
            res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
        next();
    }

    private logRegisteredRoutes(): void {
        function space(x) {
            let res = '';
            for (; x > 0; x--) {
                res += ' ';
            }
            return res;
        }

        function getBase(regexp) {
            const match = regexp
                .toString()
                .replace('\\/?', '')
                .replace('(?=\\/|$)', '$')
                .match(/^\/\^((?:\\[.*+?^${}()|[\]\\/]|[^.*+?^${}()|[\]\\/])*)\$\//);
            return match[1].replace(/\\(.)/g, '$1');
        }

        function recForEach(path: string, _router) {
            _router.stack.forEach((r) => {
                if (r.route) {
                    const method = r.route.stack[0].method.toUpperCase();
                    const route = path.concat(r.route.path);
                    Logger.Info(
                        `### ${method}${space(8 - method.length)}${route}${space(
                            50 - route.length
                        )}###`
                    );
                } else if (r.name === 'router') {
                    recForEach(path + getBase(r.regexp), r.handle);
                }
            });
        }

        function customRoutesForEach() {
            CustomRoutes.getRoutes().forEach((entry: Route) => {
                Logger.Info(
                    '### ' +
                        entry.method +
                        space(8 - entry.method.length) +
                        entry.route +
                        space(50 - entry.route.length) +
                        '###'
                );
            });
        }

        Logger.Info('#################################################################');
        Logger.Info('### DISPLAYING REGISTERED ROUTES:                             ###');
        Logger.Info('###                                                           ###');
        recForEach('', this.app._router);
        customRoutesForEach();
        Logger.Info('###                                                           ###');
        Logger.Info('#################################################################');
    }
}

export default ExpressServer;
