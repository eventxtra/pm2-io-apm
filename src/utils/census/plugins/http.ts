/**
 * Copyright 2018, OpenCensus Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License")
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { BasePlugin, Func, HeaderGetter, HeaderSetter, Span, TraceOptions } from '@opencensus/core'
import * as httpModule from 'http'
import * as semver from 'semver'
import * as shimmer from 'shimmer'
import * as url from 'url'
import * as uuid from 'uuid'

export type IgnoreMatcher<T> = string | RegExp | ((url: string, request: T) => boolean)

export type HttpPluginConfig = {
  ignoreIncomingPaths: Array<IgnoreMatcher<httpModule.IncomingMessage>>
  ignoreOutgoingUrls: Array<IgnoreMatcher<httpModule.ClientRequest>>
}

export type HttpModule = typeof httpModule
export type RequestFunction = typeof httpModule.request

/** Http instrumentation plugin for Opencensus */
export class HttpPlugin extends BasePlugin {
  /**
   * Attributes Names according to Opencensus HTTP Specs
   * https://github.com/census-instrumentation/opencensus-specs/blob/master/trace/HTTP.md
   */
  static ATTRIBUTE_HTTP_HOST = 'http.host'
  static ATTRIBUTE_HTTP_METHOD = 'http.method'
  static ATTRIBUTE_HTTP_PATH = 'http.path'
  static ATTRIBUTE_HTTP_ROUTE = 'http.route'
  static ATTRIBUTE_HTTP_USER_AGENT = 'http.user_agent'
  static ATTRIBUTE_HTTP_STATUS_CODE = 'http.status_code'
  // NOT ON OFFICIAL SPEC
  static ATTRIBUTE_HTTP_ERROR_NAME = 'http.error_name'
  static ATTRIBUTE_HTTP_ERROR_MESSAGE = 'http.error_message'

  protected options: HttpPluginConfig

  /** Constructs a new HttpPlugin instance. */
  constructor (moduleName: string) {
    super(moduleName)
  }

  /**
   * Patches HTTP incoming and outcoming request functions.
   */
  protected applyPatch () {
    this.logger.debug('applying patch to %s@%s', this.moduleName, this.version)

    shimmer.wrap(
        this.moduleExports, 'request', this.getPatchOutgoingRequestFunction())

    // In Node 8, http.get calls a private request method, therefore we patch it
    // here too.
    if (semver.satisfies(this.version, '>=8.0.0')) {
      shimmer.wrap(
          this.moduleExports, 'get', this.getPatchOutgoingRequestFunction())
    }

    if (this.moduleExports && this.moduleExports.Server &&
        this.moduleExports.Server.prototype) {
      shimmer.wrap(
          this.moduleExports.Server.prototype, 'emit',
          this.getPatchIncomingRequestFunction())
    } else {
      this.logger.error(
          'Could not apply patch to %s.emit. Interface is not as expected.',
          this.moduleName)
    }

    return this.moduleExports
  }

  /** Unpatches all HTTP patched function. */
  protected applyUnpatch (): void {
    shimmer.unwrap(this.moduleExports, 'request')
    if (semver.satisfies(this.version, '>=8.0.0')) {
      shimmer.unwrap(this.moduleExports, 'get')
    }
    if (this.moduleExports && this.moduleExports.Server &&
        this.moduleExports.Server.prototype) {
      shimmer.unwrap(this.moduleExports.Server.prototype, 'emit')
    }
  }

  /**
   * Check whether the given request is ignored by configuration
   * @param url URL of request
   * @param request Request to inspect
   * @param list List of ignore patterns
   */
  protected isIgnored<T> (
      url: string, request: T, list: Array<IgnoreMatcher<T>>): boolean {
    if (!list) {
      // No ignored urls - trace everything
      return false
    }

    for (const pattern of list) {
      if (this.isSatisfyPattern(url, request, pattern)) {
        return true
      }
    }

    return false
  }

  /**
   * Check whether the given request match pattern
   * @param url URL of request
   * @param request Request to inspect
   * @param pattern Match pattern
   */
  protected isSatisfyPattern<T> (
      url: string, request: T, pattern: IgnoreMatcher<T>): boolean {
    if (typeof pattern === 'string') {
      return pattern === url
    } else if (pattern instanceof RegExp) {
      return pattern.test(url)
    } else if (typeof pattern === 'function') {
      return pattern(url, request)
    } else {
      throw new TypeError('Pattern is in unsupported datatype')
    }
  }

  /**
   * Creates spans for incoming requests, restoring spans' context if applied.
   */
  protected getPatchIncomingRequestFunction () {
    return (original: (event: string) => boolean) => {
      const plugin = this
      if (plugin.options === undefined) {
        plugin.options = {
          ignoreIncomingPaths: [],
          ignoreOutgoingUrls: []
        }
      }
      // This function's signature is that of an event listener, which can have
      // any number of variable-type arguments.
      // tslint:disable-next-line:no-any
      return function incomingRequest (event: string, ...args: any[]): boolean {
        // Only traces request events
        if (event !== 'request') {
          return original.apply(this, arguments)
        }

        const request: httpModule.IncomingMessage = args[0]
        const response: httpModule.ServerResponse = args[1]
        // @ts-ignore
        const path = url.parse(request.url).pathname

        plugin.logger.debug('%s plugin incomingRequest', plugin.moduleName)

        if (plugin.isIgnored(path, request, plugin.options.ignoreIncomingPaths)) {
          return original.apply(this, arguments)
        }

        const propagation = plugin.tracer.propagation
        const headers = request.headers
        const getter: HeaderGetter = {
          getHeader (name: string) {
            return headers[name]
          }
        }

        const context = propagation ? propagation.extract(getter) : null
        const traceOptions: TraceOptions = {
          name: path,
          kind: 'SERVER',
          spanContext: context !== null ? context : undefined
        }

        return plugin.tracer.startRootSpan(traceOptions, rootSpan => {
          // @ts-ignore
          if (!rootSpan) return original.apply(this, arguments)

          plugin.tracer.wrapEmitter(request)
          plugin.tracer.wrapEmitter(response)

          // Wraps end (inspired by:
          // https://github.com/GoogleCloudPlatform/cloud-trace-nodejs/blob/master/src/plugins/plugin-connect.ts#L75)
          const originalEnd = response.end

          response.end = function (this: httpModule.ServerResponse) {
            response.end = originalEnd
            const returned = response.end.apply(this, arguments)

            // @ts-ignore
            const requestUrl = url.parse(request.url)
            const host = headers.host || 'localhost'
            const userAgent =
                (headers['user-agent'] || headers['User-Agent']) as string

            rootSpan.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_HOST,
                host.replace(/^(.*)(\:[0-9]{1,5})/, '$1'))
            rootSpan.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_METHOD, request.method || 'NONE')
            rootSpan.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_PATH, requestUrl.pathname)
            rootSpan.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_ROUTE, requestUrl.path)
            rootSpan.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_USER_AGENT, userAgent)

            rootSpan.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_STATUS_CODE,
                response.statusCode.toString())

            rootSpan.status =
                HttpPlugin.convertTraceStatus(response.statusCode)

            // Message Event ID is not defined
            rootSpan.addMessageEvent(
                'MessageEventTypeRecv', uuid.v4().split('-').join(''))

            rootSpan.end()
            return returned
          }

          // @ts-ignore
          return original.apply(this, arguments)
        })
      }
    }
  }

  /**
   * Creates spans for outgoing requests, sending spans' context for distributed
   * tracing.
   */
  protected getPatchOutgoingRequestFunction () {
    return (original: Func<httpModule.ClientRequest>): Func<
               httpModule.ClientRequest> => {
      const plugin = this
      if (plugin.options === undefined) {
        plugin.options = {
          ignoreIncomingPaths: [],
          ignoreOutgoingUrls: []
        }
      }
      return function outgoingRequest (
                 options: httpModule.RequestOptions | string,
                 callback): httpModule.ClientRequest {
        if (!options) {
          return original.apply(this, arguments)
        }

        // Makes sure the url is an url object
        let pathname = ''
        let method = 'GET'
        let origin = ''
        if (typeof (options) === 'string') {
          const parsedUrl = url.parse(options)
          options = parsedUrl
          // @ts-ignore
          pathname = parsedUrl.pathname
          origin = `${parsedUrl.protocol || 'http:'}//${parsedUrl.host}`
        } else {
          // Do not trace ourselves
          if (options.headers &&
              options.headers['x-opencensus-outgoing-request']) {
            plugin.logger.debug(
                'header with "x-opencensus-outgoing-request" - do not trace')
            return original.apply(this, arguments)
          }

          try {
            // @ts-ignore
            pathname = (options as url.URL).pathname || url.parse(options.path).pathname
            // @ts-ignore
            method = options.method
            origin = `${options.protocol || 'http:'}//${options.host}`
          } catch (e) {
            return original.apply(this, arguments)
          }
        }

        const request: httpModule.ClientRequest =
            original.apply(this, arguments)

        if (plugin.isIgnored(origin + pathname, request, plugin.options.ignoreOutgoingUrls)) {
          return request
        }

        plugin.tracer.wrapEmitter(request)

        plugin.logger.debug('%s plugin outgoingRequest', plugin.moduleName)
        const traceOptions = {
          name: `${method || 'GET'} ${pathname}`,
          kind: 'CLIENT'
        }
        // Checks if this outgoing request is part of an operation by checking
        // if there is a current root span, if so, we create a child span. In
        // case there is no root span, this means that the outgoing request is
        // the first operation, therefore we create a root span.
        if (!plugin.tracer.currentRootSpan) {
          plugin.logger.debug('outgoingRequest starting a root span')
          return plugin.tracer.startRootSpan(
              traceOptions,
              plugin.getMakeRequestTraceFunction(request, options, plugin))
        } else {
          plugin.logger.debug('outgoingRequest starting a child span')
          const span = plugin.tracer.startChildSpan(
              traceOptions.name, traceOptions.kind)
          return (plugin.getMakeRequestTraceFunction(request, options, plugin))(
              span)
        }
      }
    }
  }

  /**
   * Injects span's context to header for distributed tracing and finshes the
   * span when the response is finished.
   * @param original The original patched function.
   * @param options The arguments to the original function.
   */
  private getMakeRequestTraceFunction (
      request: httpModule.ClientRequest, options: httpModule.RequestOptions,
      plugin: HttpPlugin): Func<httpModule.ClientRequest> {
    return (span: Span): httpModule.ClientRequest => {
      plugin.logger.debug('makeRequestTrace')

      if (!span) {
        plugin.logger.debug('makeRequestTrace span is null')
        return request
      }

      const setter: HeaderSetter = {
        setHeader (name: string, value: string) {
          request.setHeader(name, value)
        }
      }

      const propagation = plugin.tracer.propagation
      if (propagation) {
        propagation.inject(setter, span.spanContext)
      }

      request.on('response', (response: httpModule.ClientResponse) => {
        plugin.tracer.wrapEmitter(response)
        plugin.logger.debug('outgoingRequest on response()')

        response.on('end', () => {
          plugin.logger.debug('outgoingRequest on end()')
          const method = response.method ? response.method : 'GET'
          const headers = options.headers
          const userAgent =
              headers ? (headers['user-agent'] || headers['User-Agent']) : null
          // @ts-ignore
          span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_HOST, options.hostname)
          span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_METHOD, method)
          // @ts-ignore
          span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_PATH, options.path)
          // @ts-ignore
          span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_ROUTE, options.path)
          if (userAgent) {
            span.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_USER_AGENT, userAgent.toString())
          }
          // @ts-ignore
          span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_STATUS_CODE, response.statusCode.toString())
          // @ts-ignore
          span.status = HttpPlugin.convertTraceStatus(response.statusCode)

          // Message Event ID is not defined
          span.addMessageEvent(
              'MessageEventTypeSent', uuid.v4().split('-').join(''))

          span.end()
        })

        response.on('error', error => {
          span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_ERROR_NAME, error.name)
          span.addAttribute(
              HttpPlugin.ATTRIBUTE_HTTP_ERROR_MESSAGE, error.message)
          span.status = TraceStatusCodes.UNKNOWN
          span.end()
        })
      })

      request.on('error', error => {
        span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_ERROR_NAME, error.name)
        span.addAttribute(
            HttpPlugin.ATTRIBUTE_HTTP_ERROR_MESSAGE, error.message)
        span.status = TraceStatusCodes.UNKNOWN
        span.end()
      })

      plugin.logger.debug('makeRequestTrace return request')
      return request
    }
  }

  /**
   * Converts an HTTP status code to an OpenCensus Trace status code.
   * @param statusCode The HTTP status code to convert.
   */
  static convertTraceStatus (statusCode: number): number {
    if (statusCode < 200 || statusCode > 504) {
      return TraceStatusCodes.UNKNOWN
    } else if (statusCode >= 200 && statusCode < 400) {
      return TraceStatusCodes.OK
    } else {
      switch (statusCode) {
        case (400):
          return TraceStatusCodes.INVALID_ARGUMENT
        case (504):
          return TraceStatusCodes.DEADLINE_EXCEEDED
        case (404):
          return TraceStatusCodes.NOT_FOUND
        case (403):
          return TraceStatusCodes.PERMISSION_DENIED
        case (401):
          return TraceStatusCodes.UNAUTHENTICATED
        case (429):
          return TraceStatusCodes.RESOURCE_EXHAUSTED
        case (501):
          return TraceStatusCodes.UNIMPLEMENTED
        case (503):
          return TraceStatusCodes.UNAVAILABLE
        default:
          return TraceStatusCodes.UNKNOWN
      }
    }
  }
}

/**
 * An enumeration of OpenCensus Trace status codes.
 */
export enum TraceStatusCodes {
  UNKNOWN = 2,
  OK = 0,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  PERMISSION_DENIED = 7,
  UNAUTHENTICATED = 16,
  RESOURCE_EXHAUSTED = 8,
  UNIMPLEMENTED = 12,
  UNAVAILABLE = 14
}

export const plugin = new HttpPlugin('http')
