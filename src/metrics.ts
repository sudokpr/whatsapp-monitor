export type MetricLabels = Record<string, string | number | boolean | undefined>;

export interface MetricSample {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  value: number;
  labels?: MetricLabels;
  familyName?: string;
}

export class HttpMetrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, number[]>();

  record(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = labelKey({ method, route, status_code: statusCode });
    this.requests.set(labels, (this.requests.get(labels) ?? 0) + 1);
    const values = this.durations.get(labels) ?? [];
    values.push(durationSeconds);
    this.durations.set(labels, values);
  }

  samples(): MetricSample[] {
    const samples: MetricSample[] = [];
    for (const [labels, count] of this.requests) {
      samples.push({
        name: "whatsapp_http_requests_total",
        help: "Total HTTP requests handled by the monitor API.",
        type: "counter",
        value: count,
        labels: parseLabelKey(labels),
      });
    }

    for (const [labels, values] of this.durations) {
      const parsedLabels = parseLabelKey(labels);
      samples.push({
        name: "whatsapp_http_request_duration_seconds_sum",
        help: "Total HTTP request duration in seconds.",
        type: "counter",
        value: sum(values),
        labels: parsedLabels,
      });
      samples.push({
        name: "whatsapp_http_request_duration_seconds_count",
        help: "Total HTTP request duration observations.",
        type: "counter",
        value: values.length,
        labels: parsedLabels,
      });
    }
    return samples;
  }
}

export function renderPrometheus(samples: MetricSample[]): string {
  const metadata = new Map<string, Pick<MetricSample, "help" | "type">>();
  for (const sample of samples) {
    const familyName = sample.familyName ?? sample.name;
    if (!metadata.has(familyName)) {
      metadata.set(familyName, { help: sample.help, type: sample.type });
    }
  }

  const lines: string[] = [];
  for (const [name, meta] of metadata) {
    lines.push(`# HELP ${name} ${escapeHelp(meta.help)}`);
    lines.push(`# TYPE ${name} ${meta.type}`);
    for (const sample of samples.filter((item) => (item.familyName ?? item.name) === name)) {
      lines.push(`${sample.name}${formatLabels(sample.labels)} ${formatNumber(sample.value)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function labelKey(labels: Required<MetricSample>["labels"]): string {
  return JSON.stringify(labels);
}

function parseLabelKey(key: string): MetricLabels {
  return JSON.parse(key) as MetricLabels;
}

function formatLabels(labels: MetricLabels | undefined): string {
  const entries = Object.entries(labels ?? {}).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "";
  const rendered = entries
    .map(([key, value]) => `${key}="${escapeLabelValue(String(value))}"`)
    .join(",");
  return `{${rendered}}`;
}

function escapeHelp(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function formatNumber(value: number): string {
  if (Number.isFinite(value)) return String(value);
  return "0";
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
