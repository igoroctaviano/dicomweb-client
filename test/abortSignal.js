/**
 * AbortSignal support of request options. These tests use a fake
 * XMLHttpRequest and need no DICOMweb server.
 */
class FakeXMLHttpRequest {
  constructor() {
    this.readyState = 0;
    this.status = 0;
    this.response = null;
    this.responseType = '';
    this.sent = false;
    this.aborted = false;
  }

  open() {
    this.readyState = 1;
  }

  setRequestHeader() {}

  getResponseHeader() {
    return null;
  }

  getAllResponseHeaders() {
    return '';
  }

  send() {
    this.sent = true;
  }

  abort() {
    this.aborted = true;
    this.readyState = 4;
    this.status = 0;
    if (this.onreadystatechange) {
      this.onreadystatechange();
    }
  }

  respond(status, response) {
    this.readyState = 4;
    this.status = status;
    this.response = response;
    this.onreadystatechange();
  }
}

describe('Request abort signal', function() {
  const url = 'http://localhost:8008/dcm4chee-arc/aets/DCM4CHEE/rs';
  const frameOptions = {
    studyInstanceUID: '1.2.3',
    seriesInstanceUID: '1.2.3.4',
    sopInstanceUID: '1.2.3.4.5',
    frameNumbers: [1],
  };
  let errorInterceptor;

  beforeEach(function() {
    errorInterceptor = jasmine.createSpy('errorInterceptor');
  });

  it('rejects without sending when the signal is already aborted', async function() {
    const dwc = new DICOMwebClient.api.DICOMwebClient({ url, errorInterceptor, verbose: false });
    const instance = new FakeXMLHttpRequest();
    const controller = new AbortController();
    controller.abort();
    let error;
    try {
      await dwc.retrieveInstanceFrames({
        ...frameOptions,
        request: { instance, signal: controller.signal },
      });
    } catch (e) {
      error = e;
    }
    expect(error.name).toBe('AbortError');
    expect(instance.sent).toBe(false);
    expect(errorInterceptor).not.toHaveBeenCalled();
  });

  it('aborts an in-flight request and rejects with the abort reason', async function() {
    const dwc = new DICOMwebClient.api.DICOMwebClient({ url, errorInterceptor, verbose: false });
    const instance = new FakeXMLHttpRequest();
    const controller = new AbortController();
    const reason = new Error('tile no longer needed');
    const promise = dwc.retrieveInstanceFrames({
      ...frameOptions,
      request: { instance, signal: controller.signal },
    });
    expect(instance.sent).toBe(true);
    controller.abort(reason);
    let error;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    if (controller.signal.reason !== undefined) {
      expect(error).toBe(reason);
    } else {
      /** Browsers without AbortSignal.reason (Chrome < 98) reject with AbortError */
      expect(error.name).toBe('AbortError');
    }
    expect(instance.aborted).toBe(true);
    expect(errorInterceptor).not.toHaveBeenCalled();
  });

  it('aborts the request returned by request hooks', async function() {
    const replacement = new FakeXMLHttpRequest();
    const requestHook = jasmine
      .createSpy('requestHook', function(request, metadata) {
        return request;
      })
      .and.callFake(() => replacement);
    const dwc = new DICOMwebClient.api.DICOMwebClient({
      url,
      verbose: false,
      errorInterceptor,
      requestHooks: [requestHook],
    });
    const controller = new AbortController();
    const promise = dwc.retrieveInstanceFrames({
      ...frameOptions,
      request: { instance: new FakeXMLHttpRequest(), signal: controller.signal },
    });
    expect(requestHook.calls.mostRecent().args[1].signal).toBe(
      controller.signal,
    );
    controller.abort();
    let error;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    expect(error.name).toBe('AbortError');
    expect(replacement.aborted).toBe(true);
  });

  it('rejects without sending when a request hook aborts the signal', async function() {
    const controller = new AbortController();
    const instance = new FakeXMLHttpRequest();
    const abortingHook = jasmine
      .createSpy('abortingHook', function(request, metadata) {
        return request;
      })
      .and.callFake(request => {
        controller.abort();
        return request;
      });
    const dwc = new DICOMwebClient.api.DICOMwebClient({
      url,
      verbose: false,
      requestHooks: [abortingHook],
    });
    let error;
    try {
      await dwc.retrieveInstanceFrames({
        ...frameOptions,
        request: { instance, signal: controller.signal },
      });
    } catch (e) {
      error = e;
    }
    expect(error.name).toBe('AbortError');
    expect(instance.sent).toBe(false);
  });

  it('does not pass a signal to request hooks when none is given', async function() {
    const requestHook = jasmine
      .createSpy('requestHook', function(request, metadata) {
        return request;
      })
      .and.callFake(request => request);
    const dwc = new DICOMwebClient.api.DICOMwebClient({
      url,
      verbose: false,
      requestHooks: [requestHook],
    });
    const instance = new FakeXMLHttpRequest();
    const promise = dwc.retrieveInstanceFrames({
      ...frameOptions,
      request: { instance },
    });
    expect('signal' in requestHook.calls.mostRecent().args[1]).toBe(false);
    instance.respond(200, new ArrayBuffer(0));
    await promise;
  });

  it('ignores an abort after the request has completed', async function() {
    const dwc = new DICOMwebClient.api.DICOMwebClient({ url, errorInterceptor, verbose: false });
    const instance = new FakeXMLHttpRequest();
    instance.responseType = 'arraybuffer';
    const controller = new AbortController();
    const promise = dwc.retrieveInstanceFrames({
      ...frameOptions,
      request: { instance, signal: controller.signal },
    });
    const frame = new ArrayBuffer(4);
    instance.respond(200, frame);
    const frames = await promise;
    controller.abort();
    expect(frames[0]).toBe(frame);
    expect(instance.aborted).toBe(false);
  });
});

describe('Request abort signal cleanup', function() {
  const url = 'http://localhost:8008/dcm4chee-arc/aets/DCM4CHEE/rs';
  const frameOptions = {
    studyInstanceUID: '1.2.3',
    seriesInstanceUID: '1.2.3.4',
    sopInstanceUID: '1.2.3.4.5',
    frameNumbers: [1],
  };

  it('rejects and releases the signal when send throws', async function() {
    const dwc = new DICOMwebClient.api.DICOMwebClient({ url, verbose: false });
    const instance = new FakeXMLHttpRequest();
    const sendError = new Error('send failed');
    instance.send = () => {
      throw sendError;
    };
    const controller = new AbortController();
    const removeSpy = spyOn(
      controller.signal,
      'removeEventListener',
    ).and.callThrough();
    let error;
    try {
      await dwc.retrieveInstanceFrames({
        ...frameOptions,
        request: { instance, signal: controller.signal },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBe(sendError);
    expect(removeSpy).toHaveBeenCalledWith('abort', jasmine.any(Function));
  });

  it('rejects and releases the signal on a malformed multipart body', async function() {
    const dwc = new DICOMwebClient.api.DICOMwebClient({ url, verbose: false });
    const instance = new FakeXMLHttpRequest();
    instance.getResponseHeader = () => 'multipart/related; type="application/octet-stream"';
    const controller = new AbortController();
    const removeSpy = spyOn(
      controller.signal,
      'removeEventListener',
    ).and.callThrough();
    const promise = dwc.retrieveInstanceFrames({
      ...frameOptions,
      request: { instance, signal: controller.signal },
    });
    instance.respond(200, new Uint8Array([1, 2, 3]).buffer);
    let error;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(removeSpy).toHaveBeenCalledWith('abort', jasmine.any(Function));
  });

  it('rejects when the errorInterceptor throws', async function() {
    const dwc = new DICOMwebClient.api.DICOMwebClient({
      url,
      verbose: false,
      errorInterceptor: () => {
        throw new Error('interceptor failed');
      },
    });
    const instance = new FakeXMLHttpRequest();
    const controller = new AbortController();
    const promise = dwc.retrieveInstanceFrames({
      ...frameOptions,
      request: { instance, signal: controller.signal },
    });
    try {
      instance.respond(500, null);
    } catch (e) {
      /** The interceptor's error propagates from the event handler */
    }
    let error;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    expect(error.status).toBe(500);
  });

  it('rejects with the HTTP error when the errorInterceptor aborts the signal', async function() {
    const controller = new AbortController();
    const errorInterceptor = jasmine
      .createSpy('errorInterceptor')
      .and.callFake(() => controller.abort());
    const dwc = new DICOMwebClient.api.DICOMwebClient({
      url,
      verbose: false,
      errorInterceptor,
    });
    const instance = new FakeXMLHttpRequest();
    const promise = dwc.retrieveInstanceFrames({
      ...frameOptions,
      request: { instance, signal: controller.signal },
    });
    instance.respond(401, null);
    let error;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    expect(errorInterceptor).toHaveBeenCalled();
    expect(error.status).toBe(401);
    expect(instance.aborted).toBe(false);
  });
});

describe('Request abort signal edge cases', function() {
  const url = 'http://localhost:8008/dcm4chee-arc/aets/DCM4CHEE/rs';
  const frameOptions = {
    studyInstanceUID: '1.2.3',
    seriesInstanceUID: '1.2.3.4',
    sopInstanceUID: '1.2.3.4.5',
    frameNumbers: [1],
  };

  it('rejects on abort even when abort() of the sent request throws', async function() {
    const replacement = new FakeXMLHttpRequest();
    replacement.abort = () => {
      throw new Error('abort failed');
    };
    const requestHook = jasmine
      .createSpy('requestHook', function(request, metadata) {
        return request;
      })
      .and.callFake(() => replacement);
    const dwc = new DICOMwebClient.api.DICOMwebClient({
      url,
      verbose: false,
      requestHooks: [requestHook],
    });
    const controller = new AbortController();
    const promise = dwc.retrieveInstanceFrames({
      ...frameOptions,
      request: { instance: new FakeXMLHttpRequest(), signal: controller.signal },
    });
    controller.abort();
    let error;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    expect(error.name).toBe('AbortError');
  });

  it('rejects with an AbortError where DOMException is not available', async function() {
    const dwc = new DICOMwebClient.api.DICOMwebClient({ url, verbose: false });
    const instance = new FakeXMLHttpRequest();
    /** An aborted signal without a reason, as in environments predating AbortSignal.reason */
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {},
    };
    const savedDOMException = window.DOMException;
    let error;
    window.DOMException = undefined;
    try {
      await dwc.retrieveInstanceFrames({
        ...frameOptions,
        request: { instance, signal },
      });
    } catch (e) {
      error = e;
    } finally {
      window.DOMException = savedDOMException;
    }
    expect(error instanceof Error).toBe(true);
    expect(error.name).toBe('AbortError');
    expect(instance.sent).toBe(false);
  });

  it('resolves through a request object returned by a request hook', async function() {
    const replacement = new FakeXMLHttpRequest();
    replacement.responseType = 'arraybuffer';
    const requestHook = jasmine
      .createSpy('requestHook', function(request, metadata) {
        return request;
      })
      .and.callFake(() => replacement);
    const dwc = new DICOMwebClient.api.DICOMwebClient({
      url,
      verbose: false,
      requestHooks: [requestHook],
    });
    const promise = dwc.retrieveInstanceFrames({
      ...frameOptions,
      request: { instance: new FakeXMLHttpRequest() },
    });
    expect(replacement.sent).toBe(true);
    const body = new ArrayBuffer(4);
    replacement.respond(200, body);
    const frames = await promise;
    expect(frames[0]).toBe(body);
  });

  it('keeps a handler that a request hook wraps on the same request object', async function() {
    const wrapped = jasmine.createSpy('wrappedReadyStateChange');
    const requestHook = jasmine
      .createSpy('requestHook', function(request, metadata) {
        return request;
      })
      .and.callFake(request => {
        const previous = request.onreadystatechange;
        request.onreadystatechange = function() {
          wrapped();
          previous.call(request);
        };
        return request;
      });
    const dwc = new DICOMwebClient.api.DICOMwebClient({
      url,
      verbose: false,
      requestHooks: [requestHook],
    });
    const instance = new FakeXMLHttpRequest();
    const promise = dwc.retrieveInstanceFrames({
      ...frameOptions,
      request: { instance },
    });
    const body = new ArrayBuffer(4);
    instance.respond(200, body);
    const frames = await promise;
    expect(wrapped).toHaveBeenCalled();
    expect(frames[0]).toBe(body);
  });

  it('aborts a retry that a request hook sends on the same request object', async function() {
    const errorInterceptor = jasmine.createSpy('errorInterceptor');
    let sendCount = 0;
    let pendingRetry = null;
    /**
     * Retry hook in the style of a viewer's: it keeps the request object,
     * wraps send(), holds back a 503 from the client's handler and sends the
     * same object again.
     */
    const retryHook = jasmine
      .createSpy('retryHook', function(request, metadata) {
        return request;
      })
      .and.callFake((request, metadata) => {
        const originalSend = request.send;
        request.send = function(...args) {
          const downstream = request.onreadystatechange;
          const attempt = () => {
            request.onreadystatechange = function() {
              if (request.readyState !== 4) {
                return;
              }
              if (request.status === 503 && sendCount < 3) {
                pendingRetry = () => {
                  pendingRetry = null;
                  request.open(metadata.method, metadata.url, true);
                  attempt();
                };
                return;
              }
              downstream.call(request);
            };
            sendCount += 1;
            originalSend.apply(request, args);
          };
          attempt();
        };
        return request;
      });
    const dwc = new DICOMwebClient.api.DICOMwebClient({
      url,
      verbose: false,
      errorInterceptor,
      requestHooks: [retryHook],
    });
    const instance = new FakeXMLHttpRequest();
    const controller = new AbortController();
    const promise = dwc.retrieveInstanceFrames({
      ...frameOptions,
      request: { instance, signal: controller.signal },
    });
    instance.respond(503, null);
    expect(pendingRetry).not.toBeNull();
    pendingRetry();
    expect(sendCount).toBe(2);
    controller.abort();
    let error;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    expect(error.name).toBe('AbortError');
    expect(instance.aborted).toBe(true);
    expect(errorInterceptor).not.toHaveBeenCalled();
  });
});
