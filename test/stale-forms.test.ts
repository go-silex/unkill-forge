import { expect, it } from 'vitest'
import { configuration } from '../src/config'
import type { Member } from '../src/core'
import { deleteArtefact, getArtefact, listDeletedArtefacts, publish } from '../src/core/artefacts'
import { purgeArtefact } from '../src/core/purge'
import {
  admin,
  type Browser,
  configuredEnv,
  formValue,
  location,
  navigation,
  runtime,
  setupStorage,
} from './http'
import { mockProvider, setupOidc } from './oidc'

setupStorage()
setupOidc()

const slug = 'reused-report'
const detail = `/artefacts/${slug}`
const deleted = '/admin/deleted'

async function fixture() {
  const owner = await mockProvider().signedIn(runtime(), admin)
  const env = configuredEnv()
  const config = configuration(env)
  const member = await env.DB.prepare(
    'SELECT id, kind, name, email, role, status FROM members WHERE email = ?',
  )
    .bind(`${admin}@example.test`)
    .first<Member>()
  if (!config || !member) throw new Error('Expected an active admin and test configuration')
  return { owner, member, core: { env, config } }
}

async function html(owner: Browser, path: string | URL) {
  const response = await owner.request(path, { headers: { ...navigation, 'Sec-Fetch-Site': 'same-origin' } })
  expect(response.status).toBe(200)
  return response.text()
}

function actionForm(page: string, action: string) {
  const form = page
    .match(/<form\b[^>]*>[\s\S]*?<\/form>/g)
    ?.find((value) => value.includes(`name="action" value="${action}"`))
  if (!form) throw new Error(`Missing ${action} form`)
  return form
}

async function expectConflict(owner: Browser, path: string, values: Record<string, string>) {
  const response = await owner.post(path, values)
  expect(response.status, values.action).toBe(303)
  const destination = location(response)
  expect(destination.pathname).toBe(path)
  expect(await html(owner, destination), values.action).toContain(
    'The change conflicts with the current state.',
  )
}

function edition(title: string) {
  return { slug, title, mode: 'replace' as const, files: [{ path: 'index.html', content: title }] }
}

it('refuses cached access, visibility, revision restore, share creation, rename and delete on a replacement', async () => {
  const { owner, member, core } = await fixture()
  await publish(core, member, edition('Original first edition'))
  await publish(core, member, edition('Original second edition'))
  const original = await html(owner, detail)
  const revisionForm = actionForm(original, 'restore-revision')
  const artefactId = formValue(revisionForm, 'artefactId')

  await deleteArtefact(core, member, slug)
  expect(await purgeArtefact(core, member, artefactId)).toEqual({ done: true })
  await publish(core, member, edition('Replacement first edition'))
  await publish(core, member, edition('Replacement second edition'))

  const actions = [
    ['access', { access: 'shared' }],
    ['visibility', { visibility: 'public' }],
    ['restore-revision', { revision: formValue(revisionForm, 'revision') }],
    ['create-share', { label: 'Stale link' }],
    ['rename', { slug: 'renamed-by-stale-form' }],
    ['delete', {}],
  ] as const
  for (const [action, values] of actions) {
    const formId = formValue(actionForm(original, action === 'visibility' ? 'access' : action), 'artefactId')
    expect(formId).toBe(artefactId)
    await expectConflict(owner, detail, { action, ...values, artefactId: formId })
  }
  expect(await getArtefact(core, member, slug)).toMatchObject({
    title: 'Replacement second edition',
    revision: 2,
    visibility: 'private',
    shareLinks: [],
  })
})

it('refuses cached deleted restore and purge forms on a deleted replacement', async () => {
  const { owner, member, core } = await fixture()
  await publish(core, member, edition('Original'))
  await deleteArtefact(core, member, slug)
  const original = await html(owner, deleted)
  const restore = actionForm(original, 'restore')
  const purge = actionForm(original, 'purge')
  const id = formValue(purge, 'id')
  expect(formValue(restore, 'artefactId')).toBe(id)

  expect(await purgeArtefact(core, member, id)).toEqual({ done: true })
  await publish(core, member, edition('Replacement'))
  await deleteArtefact(core, member, slug)
  const replacement = await listDeletedArtefacts(core, member)
  expect(replacement.artefacts).toEqual([
    expect.objectContaining({ title: 'Replacement', slug, restorable: true, purging: false }),
  ])
  expect(replacement.artefacts[0].id).not.toBe(id)

  await expectConflict(owner, deleted, {
    action: 'restore',
    slug: formValue(restore, 'slug'),
    artefactId: formValue(restore, 'artefactId'),
  })
  await expectConflict(owner, deleted, { action: 'purge', id, slug: formValue(purge, 'slug') })
  expect(await listDeletedArtefacts(core, member)).toEqual(replacement)
})
