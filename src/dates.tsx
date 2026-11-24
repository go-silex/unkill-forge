import type { Config } from './config'

type DateConfig = Pick<Config, 'locale' | 'timeZone'>
type DateFormats = {
  absolute: Intl.DateTimeFormat
  short: Intl.DateTimeFormat
  relative: Intl.RelativeTimeFormat
  now: string
}

const dateFormats = new WeakMap<DateConfig, DateFormats>()

function dateFormat(config: DateConfig) {
  const cached = dateFormats.get(config)
  if (cached) return cached
  const { locale, timeZone } = config
  const language = locale === 'fr' ? 'fr-FR' : 'en-GB'
  const format = {
    absolute: new Intl.DateTimeFormat(language, {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }),
    short: new Intl.DateTimeFormat(language, { timeZone, dateStyle: 'short' }),
    relative: new Intl.RelativeTimeFormat(language, { style: 'short' }),
    now: new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' }).format(0, 'second'),
  }
  dateFormats.set(config, format)
  return format
}

export function absoluteTime(config: DateConfig, timestamp: number | null) {
  return timestamp === null ? '—' : dateFormat(config).absolute.format(timestamp)
}

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const week = 7 * day

export function time(config: DateConfig, timestamp: number | null) {
  if (timestamp === null) return '—'
  const format = dateFormat(config)
  const delta = timestamp - Date.now()
  const distance = Math.abs(delta)
  let relative: string
  if (distance < minute) relative = format.now
  else if (distance < hour) relative = format.relative.format(Math.trunc(delta / minute), 'minute')
  else if (distance < day) relative = format.relative.format(Math.trunc(delta / hour), 'hour')
  else if (distance < week) relative = format.relative.format(Math.trunc(delta / day), 'day')
  else if (distance <= 8 * week) relative = format.relative.format(Math.trunc(delta / week), 'week')
  else relative = format.short.format(timestamp)
  return (
    <time datetime={new Date(timestamp).toISOString()} title={absoluteTime(config, timestamp)}>
      {relative}
    </time>
  )
}
