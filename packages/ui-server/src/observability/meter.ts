/**
 * An in-process `MeterProvider` — the counters behind `/api/status`, and the
 * assertion surface for tests.
 *
 * One implementation serves both on purpose. A test double that is a different
 * implementation from the production one only proves the double works; this
 * way, the thing a test asserts against is the thing that actually counts in
 * production.
 *
 * It is NOT `@opentelemetry/sdk-metrics`. The producing side is the standard
 * API, so instrumentation is portable and a real SDK can replace this without
 * touching a single `counter.add()` call — but the consuming side is ours,
 * which is what keeps the dependency surface to one stable package.
 *
 * Synchronous instruments (counter, up-down counter, histogram, gauge) record.
 * The observable/async instruments satisfy the interface and do nothing: they
 * require a collection cycle to be meaningful, and nothing here runs one. A
 * caller reaching for one is a signal to bring in a real SDK, not to grow this.
 */
import type {
  Attributes,
  BatchObservableCallback,
  Counter,
  Gauge,
  Histogram,
  Meter,
  MeterOptions,
  MeterProvider,
  MetricOptions,
  Observable,
  ObservableCounter,
  ObservableGauge,
  ObservableUpDownCounter,
  UpDownCounter,
} from "@opentelemetry/api";

import {
  flattenAttributes,
  seriesKey,
  type MetricPoint,
  type MetricSnapshot,
} from "./types.js";

/** Read side of the recorded metrics. */
export interface MetricsReader {
  /** Every recorded series, sorted by name then attribute key. */
  snapshot(): MetricSnapshot;
  /** One series' value, or undefined when nothing recorded it. */
  value(name: string, attributes?: Attributes): number | undefined;
  /** Summed across every attribute combination of an instrument. */
  total(name: string): number;
  reset(): void;
}

interface Series extends MetricPoint {
  key: string;
}

class Recorder {
  private readonly series = new Map<string, Series>();

  record(
    name: string,
    kind: MetricPoint["kind"],
    value: number,
    attributes: Attributes | undefined
  ): void {
    const key = seriesKey(name, attributes);
    const existing = this.series.get(key);
    if (existing) {
      // A gauge is a level, not an accumulation.
      existing.value = kind === "gauge" ? value : existing.value + value;
      return;
    }
    this.series.set(key, { key, name, kind, value, attributes: flattenAttributes(attributes) });
  }

  snapshot(): MetricSnapshot {
    return [...this.series.values()]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ name, attributes, value, kind }) => ({ name, attributes, value, kind }));
  }

  value(name: string, attributes?: Attributes): number | undefined {
    return this.series.get(seriesKey(name, attributes))?.value;
  }

  total(name: string): number {
    let sum = 0;
    for (const s of this.series.values()) if (s.name === name) sum += s.value;
    return sum;
  }

  reset(): void {
    this.series.clear();
  }
}

/** Instruments that do nothing, for the async half of the Meter interface. */
function noopObservable<T>(): T {
  return {
    addCallback() {},
    removeCallback() {},
  } as T;
}

class InMemoryMeter implements Meter {
  constructor(private readonly recorder: Recorder) {}

  createCounter<A extends Attributes = Attributes>(
    name: string,
    _options?: MetricOptions
  ): Counter<A> {
    return {
      add: (value: number, attributes?: A) =>
        this.recorder.record(name, "counter", value, attributes),
    } as Counter<A>;
  }

  createUpDownCounter<A extends Attributes = Attributes>(
    name: string,
    _options?: MetricOptions
  ): UpDownCounter<A> {
    return {
      add: (value: number, attributes?: A) =>
        this.recorder.record(name, "updowncounter", value, attributes),
    } as UpDownCounter<A>;
  }

  createHistogram<A extends Attributes = Attributes>(
    name: string,
    _options?: MetricOptions
  ): Histogram<A> {
    return {
      // Count of observations, not the distribution: a real SDK owns buckets.
      record: (_value: number, attributes?: A) =>
        this.recorder.record(name, "histogram", 1, attributes),
    } as Histogram<A>;
  }

  createGauge<A extends Attributes = Attributes>(
    name: string,
    _options?: MetricOptions
  ): Gauge<A> {
    return {
      record: (value: number, attributes?: A) =>
        this.recorder.record(name, "gauge", value, attributes),
    } as Gauge<A>;
  }

  createObservableGauge<A extends Attributes = Attributes>(): ObservableGauge<A> {
    return noopObservable<ObservableGauge<A>>();
  }
  createObservableCounter<A extends Attributes = Attributes>(): ObservableCounter<A> {
    return noopObservable<ObservableCounter<A>>();
  }
  createObservableUpDownCounter<
    A extends Attributes = Attributes,
  >(): ObservableUpDownCounter<A> {
    return noopObservable<ObservableUpDownCounter<A>>();
  }
  addBatchObservableCallback<A extends Attributes = Attributes>(
    _callback: BatchObservableCallback<A>,
    _observables: Observable<A>[]
  ): void {}
  removeBatchObservableCallback<A extends Attributes = Attributes>(
    _callback: BatchObservableCallback<A>,
    _observables: Observable<A>[]
  ): void {}
}

export interface InMemoryMeterProvider extends MeterProvider, MetricsReader {}

/**
 * A provider whose meters all write into one recorder, so a snapshot spans
 * every instrumentation scope in the process.
 */
export function createInMemoryMeterProvider(): InMemoryMeterProvider {
  const recorder = new Recorder();
  const meter = new InMemoryMeter(recorder);
  return {
    getMeter(_name: string, _version?: string, _options?: MeterOptions): Meter {
      return meter;
    },
    snapshot: () => recorder.snapshot(),
    value: (name, attributes) => recorder.value(name, attributes),
    total: (name) => recorder.total(name),
    reset: () => recorder.reset(),
  };
}
