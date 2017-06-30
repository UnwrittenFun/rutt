import * as Hapi from "hapi";
import * as Boom from "boom";
import { cloneDeepWith, isPlainObject } from "lodash";

import { Route, Controller, RuttReply, RuttRequest } from "./route";

export interface RuttOptions extends Hapi.ServerOptions {}

export interface RuttConnectionOptions extends Hapi.ServerConnectionOptions {}

export interface RouteContext {
    controller?: Controller<any>;
    path: string;
    params: { [key: string]: Hapi.JoiValidationObject };
}

export class Rutt {
    public server: Hapi.Server;
    protected hapiRoutes: Hapi.RouteConfiguration[];

    constructor(options?: RuttOptions) {
        this.server = new Hapi.Server(options);
    }

    public connection(options: RuttConnectionOptions) {
        return this.server.connection(options);
    }

    public start(): Promise<void> {
        this.hapiRoutes.forEach(route => {
            console.log(`[${route.method}] ${route.path}`);
            this.server.route(route);
        });

        return this.server.start().then(() => undefined);
    }

    public register(plugin: any): Promise<any>;
    public register(plugins: any[]): Promise<any>;
    public register(plugins: any | any[]): Promise<any> {
        return this.server.register(plugins) as Promise<any>;
    }

    public routes(routes: Route[]) {
        this.hapiRoutes = this.compileRoutes(routes);
    }

    protected compileRoutes(routes: Route[], context: RouteContext = { path: "", params: {} }) {
        const hapiRoutes = [];
        routes.forEach(route => {
            const ctx = cloneDeepWith(context, obj => {
                if (!isPlainObject(obj)) {
                    return obj;
                }
            });
            const config: any = { validate: {} };

            // Assemble path based on the parent routes.
            if (route.path != null) {
                let path = route.path;
                if (path.startsWith(":")) {
                    path = `{${path.slice(1)}}`;
                }

                ctx.path += `/${path}`;
            }

            // Replace the controller in the current context.
            if (route.controller) {
                ctx.controller = this.constructController(route.controller);
            }

            if (route.config) {
                Object.assign(config, route.config);
            }

            if (route.validate) {
                config.validate = route.validate;

                if (route.validate.params) {
                    Object.assign(ctx.params, route.validate.params);
                }
            }

            config.validate.params = Object.assign(config.validate.params || {}, ctx.params);

            // This is a destination route.
            if (route.handler) {
                if (!ctx.controller) {
                    throw new Error("Cannot register route handler without an existing controller");
                }

                if (!ctx.controller[route.handler]) {
                    throw new Error(
                        `${route.handler} does not exists on controller ${ctx.controller.constructor
                            .name}`
                    );
                }

                hapiRoutes.push({
                    config,
                    method: route.method || "get",
                    path: ctx.path,
                    handler: (req, reply) => {
                        this.runGuards(route, req, reply)
                            .then(() => {
                                return ctx.controller[route.handler].call(
                                    ctx.controller,
                                    req,
                                    reply
                                );
                            })
                            .then(res => {
                                if (reply._replied) {
                                    return;
                                }

                                if (res == null) {
                                    reply().code(204);
                                    return;
                                }

                                reply(res);
                            })
                            .catch(err => {
                                if (reply._replied) {
                                    return;
                                }

                                if (err.isBoom) {
                                    reply(err);
                                    return;
                                }

                                this.handleError(err, reply);
                            });
                    }
                });
            }

            // Compile child routes.
            if (route.children) {
                hapiRoutes.push(...this.compileRoutes(route.children, ctx));
            }
        });
        return hapiRoutes;
    }

    private async runGuards(route: Route, req: RuttRequest, reply: RuttReply): Promise<void> {
        if (!route.guards) {
            return;
        }

        for (let i = 0, len = route.guards.length; i < len; i++) {
            await route.guards[i](req, reply);
            if (reply._replied) {
                return;
            }
        }
    }

    protected handleError(err: any, reply: RuttReply) {
        console.log(err);
        reply(Boom.badImplementation(err.message || err, err.stack));
    }

    protected constructController(controllerCtor: Controller<any>): any {
        return new controllerCtor();
    }
}
