import { type FormEvent, useState } from 'react'
import { RemoveButton } from '@/components/settings/storage/connectors'
import { type Go, StorageFrame } from '@/components/settings/storage/page'
import {
  Callout,
  Card,
  Dot,
  Field,
  KIND_NAME,
  KV,
  OBtn,
  PBtn,
  StorageHeader,
  Tag,
} from '@/components/settings/storage/ui'
import type { Destination, DestinationKind, NewDestination, VerifyResult, VerifyStep } from '@/gen'
import { isOwner, useMe } from '@/lib/auth-api'
import { useCreateDestination, useHistory, useTestDestination, useUpdateDestination } from '@/lib/history-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

// Connect / edit a storage connector (v1.1-04 R2, 07 S3, 25 S3 keys, 08
// S3-compatible), its connection test (05 failed, 06 verified), then save.

type Auth = 'host' | 'keys'

interface Draft {
  name: string
  endpoint: string
  bucket: string
  region: string
  prefix: string
  pathStyle: boolean
  auth: Auth
  key: string
  secret: string
  token: string
}

const PLACEHOLDER: Record<DestinationKind, Partial<Record<keyof Draft, string>>> = {
  garage: { name: 'garage', endpoint: 'http://garage:3900', bucket: 'quiet-history', key: 'GARAGE_ACCESS_KEY_ID' },
  r2: {
    name: 'production-r2',
    bucket: 'quiet-production',
    endpoint: 'https://<account>.r2.cloudflarestorage.com',
    key: 'R2_ACCESS_KEY_ID',
  },
  s3: { name: 'disaster-recovery', bucket: 'quiet-dr', region: 'eu-west-1', key: 'AWS_ACCESS_KEY_ID' },
  s3_compatible: {
    name: 'team-object-storage',
    endpoint: 'https://s3.storage.example.com',
    bucket: 'quiet-history',
    region: 'us-east-1',
    key: 'STORAGE_ACCESS_KEY_ID',
  },
}

const SUB: Record<DestinationKind, string> = {
  garage: 'Use the Garage service running next to Quiet.',
  r2: 'Use an existing bucket to retain logs and traces.',
  s3: 'Use an existing bucket in your AWS account.',
  s3_compatible: 'Use your provider’s endpoint and signing region.',
}

const STEP_LABEL: Record<VerifyStep['step'], string> = {
  list: 'List prefix',
  write: 'Write object',
  read: 'Read object',
  delete: 'Delete test object',
}

const ORDER: VerifyStep['step'][] = ['list', 'write', 'read', 'delete']

const draftOf = (kind: DestinationKind, d?: Destination): Draft => ({
  name: d?.name ?? '',
  endpoint: d?.endpoint ?? '',
  bucket: d?.bucket ?? '',
  region: d?.region ?? (kind === 'r2' ? 'auto' : ''),
  prefix: d?.prefix ?? 'quiet/',
  pathStyle: d?.path_style ?? (kind !== 'r2' && kind !== 's3'),
  auth: d && kind === 's3' && !d.access_key_preview ? 'host' : kind === 's3' && !d ? 'host' : 'keys',
  key: '',
  secret: '',
  token: '',
})

function body(kind: DestinationKind, f: Draft): NewDestination {
  const host = kind === 's3' && f.auth === 'host'
  return {
    name: f.name.trim(),
    kind,
    endpoint: f.endpoint.trim() || undefined,
    region: f.region.trim() || undefined,
    bucket: f.bucket.trim(),
    prefix: f.prefix.trim() || undefined,
    path_style: f.pathStyle,
    access_key_id: host ? '' : f.key.trim(),
    secret_access_key: host ? '' : f.secret,
    session_token: host ? undefined : f.token.trim() || undefined,
  }
}

/** The AWS-style error code in a provider message: `AccessDenied`. */
export function providerCode(e: string | undefined | null): string | null {
  return (
    e?.match(
      /\b(AccessDenied|NoSuchBucket|InvalidAccessKeyId|SignatureDoesNotMatch|AuthorizationHeaderMalformed|ObjectLocked\w*|InvalidBucketName|PermanentRedirect|ExpiredToken)\b/,
    )?.[1] ?? null
  )
}

/** What a step says: `quiet/`, `Test object created`, `Not run · write failed`, `Access denied · …`. */
function stepText(s: VerifyStep, prefix: string): string {
  if (s.skipped) return `Not run · ${s.error ?? 'an earlier step failed'}`
  if (s.ok)
    return { list: prefix, write: 'Test object created', read: 'Test object read', delete: 'Test object removed' }[
      s.step
    ]
  if (providerCode(s.error) === 'AccessDenied')
    return s.step === 'delete' ? 'Access denied · Delete required' : `Access denied · Object Read & Write required`
  return s.error ?? 'Failed'
}

export function ConnectForm({ kind, editing, go }: { kind: DestinationKind; editing?: Destination; go: Go }) {
  const owner = isOwner(useMe())
  const h = useHistory().data
  const [f, setF] = useState<Draft>(() => draftOf(kind, editing))
  const [show, setShow] = useState(false)
  const [tokenOpen, setTokenOpen] = useState(false)
  const [result, setResult] = useState<VerifyResult | null>(null)
  const test = useTestDestination()
  const create = useCreateDestination()
  const update = useUpdateDestination()
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }))
  const title = editing ? `Edit ${editing.name}` : `Connect ${KIND_NAME[kind]}`
  const prefix = f.prefix.trim() || 'quiet/'

  const runTest = async (e?: FormEvent) => {
    e?.preventDefault()
    try {
      // Editing with the key or secret left blank: the saved ones are used.
      setResult(await test.mutateAsync({ ...body(kind, f), id: editing?.id }))
    } catch (err) {
      toast.error('Could not test the connection', { description: (err as Error).message })
    }
  }
  const save = async () => {
    try {
      if (editing) {
        const n = body(kind, f)
        await update.mutateAsync({
          id: editing.id,
          name: n.name,
          endpoint: n.endpoint ?? '',
          region: n.region ?? '',
          bucket: n.bucket,
          prefix: n.prefix,
          path_style: n.path_style,
          access_key_id: f.auth === 'host' && kind === 's3' ? '' : f.key.trim() || undefined,
          secret_access_key: f.secret || undefined,
          session_token: f.token.trim() || undefined,
        })
        toast.success(`${n.name} saved`)
      } else {
        await create.mutateAsync({ ...body(kind, f), activate: false })
        toast.success(`${f.name.trim()} saved`, {
          description: 'Activate it on Connectors when it should receive history.',
        })
      }
      go({ tab: 'connectors' })
    } catch (err) {
      toast.error('Could not save the connector', { description: (err as Error).message })
    }
  }

  if (result) {
    const failed = result.steps.find((s) => !s.ok && !s.skipped)
    const passed = result.steps.filter((s) => s.ok).length
    const notRun = result.steps.filter((s) => s.skipped).length
    const fails = result.steps.length - passed - notRun
    const canSave = result.ok
    const steps = [...result.steps].sort((a, b) => ORDER.indexOf(a.step) - ORDER.indexOf(b.step))
    return (
      <StorageFrame
        tab="connectors"
        header={
          <StorageHeader
            title={title}
            sub={
              canSave
                ? 'Connection verified. Save it before choosing where new history goes.'
                : 'Resolve the failed check before saving this connection.'
            }
          />
        }
      >
        <Card title={f.name.trim() || PLACEHOLDER[kind].name} aside={<Tag>{KIND_NAME[kind]}</Tag>}>
          <div className="flex flex-col gap-3 p-4">
            <KV k="Bucket">{f.bucket.trim()}</KV>
            <KV k="Object prefix">{prefix}</KV>
            {kind === 's3' ? (
              <KV k="AWS region" muted>
                {f.region.trim() || 'us-east-1'}
              </KV>
            ) : (
              <KV k={kind === 's3_compatible' ? 'Endpoint' : 'S3 endpoint'} muted>
                {f.endpoint.trim().replace(/^https?:\/\//, '')}
              </KV>
            )}
          </div>
        </Card>
        <section aria-label="Connection test" className="flex flex-col border bg-card">
          <div className="flex min-h-10 items-center gap-3 border-b px-4 py-2">
            <h3 className="flex-1 font-medium text-[13px] leading-[18px]">Connection test</h3>
            <span className="font-mono text-muted-foreground text-xs leading-[18px]">
              {passed === result.steps.length
                ? `${passed} of ${passed} checks passed`
                : [`${passed} passed`, fails && `${fails} failed`, notRun && `${notRun} not run`]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
          </div>
          {steps.map((s) => (
            <div key={s.step} className="flex items-center gap-3 border-t px-4 py-3 first-of-type:border-t-0">
              <Dot tone={s.ok ? 'ok' : s.skipped ? 'idle' : 'err'} />
              <span className="w-[190px] shrink-0 text-xs leading-[18px]">{STEP_LABEL[s.step]}</span>
              <span
                className={cn(
                  'min-w-0 flex-1 break-words font-mono text-xs leading-[18px]',
                  !s.ok && !s.skipped ? 'text-level-error' : 'text-muted-foreground',
                )}
              >
                {stepText(s, prefix)}
              </span>
            </div>
          ))}
        </section>
        {canSave && result.cleanup && (
          <Callout title="Ready to save">
            These checks verify the operations Quiet needs today. The shared policy also applies to this connector after
            saving.
          </Callout>
        )}
        {canSave && !result.cleanup && (
          <Callout tone="warn" title="Delete permission is missing">
            Quiet can store and search history here, but retention and eviction can’t remove old objects. Give the key
            delete access to {prefix}, or expect cleanup to be blocked.
          </Callout>
        )}
        {!canSave && failed && (
          <Callout
            tone="err"
            title={
              providerCode(failed.error) === 'AccessDenied'
                ? `${STEP_LABEL[failed.step].split(' ')[0]} permission is missing`
                : 'Connection test failed'
            }
          >
            {providerCode(failed.error) === 'AccessDenied'
              ? failed.step === 'write'
                ? `This key can list ${f.bucket.trim()} but cannot write to it. Give the key Object Read & Write access to this bucket, then retry the test.`
                : `This key can’t ${failed.step} in ${f.bucket.trim()}. Give it list, read, write and delete access to ${prefix}, then retry the test.`
              : `The provider answered: ${failed.error}. Check the endpoint, bucket and credentials, then retry the test.`}
          </Callout>
        )}
        {failed && providerCode(failed.error) && (
          <p className="font-mono text-[11px] text-muted-foreground leading-[14px]">
            Provider response · {providerCode(failed.error)}
          </p>
        )}
        <div className="flex justify-end gap-3">
          {canSave ? (
            <>
              <OBtn onClick={() => setResult(null)}>Back</OBtn>
              <PBtn onClick={save} disabled={!owner || create.isPending || update.isPending}>
                {editing ? 'Save changes' : 'Save connector'}
              </PBtn>
            </>
          ) : (
            <>
              <OBtn onClick={() => setResult(null)}>Edit connection</OBtn>
              <PBtn onClick={() => runTest()} disabled={test.isPending}>
                Retry test
              </PBtn>
            </>
          )}
        </div>
      </StorageFrame>
    )
  }

  const keys = !(kind === 's3' && f.auth === 'host')
  const secretSaved = Boolean(editing)
  return (
    <StorageFrame tab="connectors" header={<StorageHeader title={title} sub={SUB[kind]} />}>
      <form className="flex flex-col gap-5" onSubmit={runTest} aria-label={title}>
        <Field
          label="Connection name"
          value={f.name}
          onChange={set('name')}
          placeholder={PLACEHOLDER[kind].name}
          required
        />
        {kind === 's3_compatible' || kind === 'garage' ? (
          <Field
            label="Endpoint"
            value={f.endpoint}
            onChange={set('endpoint')}
            placeholder={PLACEHOLDER[kind].endpoint}
            hint="Use the S3 API endpoint provided by your storage service."
            required
          />
        ) : null}
        {kind === 'r2' ? (
          <>
            <Field
              label="Bucket"
              value={f.bucket}
              onChange={set('bucket')}
              placeholder={PLACEHOLDER.r2.bucket}
              hint="Create the bucket in Cloudflare before connecting it."
              required
            />
            <Field
              label="S3 endpoint"
              value={f.endpoint}
              onChange={set('endpoint')}
              placeholder={PLACEHOLDER.r2.endpoint}
              hint="Copy the bucket’s S3 API endpoint, including its jurisdiction if applicable."
              required
            />
            <div className="flex items-start gap-3">
              <Field className="flex-1" label="Object prefix" value={f.prefix} onChange={set('prefix')} />
              <Field className="w-[180px]" label="Region" value={f.region} readOnly hint="Set automatically for R2." />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <Field
                className="flex-1"
                label="Bucket"
                value={f.bucket}
                onChange={set('bucket')}
                placeholder={PLACEHOLDER[kind].bucket}
                required
              />
              <Field
                className="w-[220px]"
                label={kind === 's3' ? 'AWS region' : 'Signing region'}
                value={f.region}
                onChange={set('region')}
                placeholder={PLACEHOLDER[kind].region ?? 'us-east-1'}
              />
            </div>
            {kind === 's3' ? (
              <Field
                label="Object prefix"
                value={f.prefix}
                onChange={set('prefix')}
                hint="Quiet reads and writes objects under this prefix."
              />
            ) : (
              <div className="flex items-start gap-3">
                <Field className="flex-1" label="Object prefix" value={f.prefix} onChange={set('prefix')} />
                <label className="flex w-[220px] flex-col gap-1.5">
                  <span className="font-medium text-xs leading-[18px]">Addressing</span>
                  <select
                    className="h-8 border border-input bg-card px-2.5 font-mono text-xs outline-none focus:border-ring"
                    value={f.pathStyle ? 'path' : 'virtual'}
                    onChange={(e) => setF((p) => ({ ...p, pathStyle: e.target.value === 'path' }))}
                  >
                    <option value="path">Path style</option>
                    <option value="virtual">Virtual-hosted style</option>
                  </select>
                </label>
              </div>
            )}
          </>
        )}

        {kind === 's3' && (
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-xs leading-[18px]">Authentication</span>
            <div role="radiogroup" aria-label="Authentication" className="flex">
              {(
                [
                  ['host', 'Host credentials'],
                  ['keys', 'Access keys'],
                ] as const
              ).map(([v, label]) => (
                // biome-ignore lint/a11y/useSemanticElements: a segmented control drawn as buttons (v1.1-07)
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={f.auth === v}
                  onClick={() => setF((p) => ({ ...p, auth: v }))}
                  className={cn(
                    'h-7 border border-input px-3 text-xs leading-4 -ml-px first:ml-0',
                    f.auth === v ? 'bg-foreground text-background' : 'bg-background text-foreground hover:bg-muted',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {keys ? (
          <>
            <div className="flex items-start gap-3">
              <Field
                className="flex-1"
                label="Access Key ID"
                value={f.key}
                onChange={set('key')}
                placeholder={editing?.access_key_preview || PLACEHOLDER[kind].key}
                required={!editing}
                autoComplete="off"
              />
              <Field
                className="flex-1"
                label="Secret Access Key"
                type={show ? 'text' : 'password'}
                value={f.secret}
                onChange={set('secret')}
                placeholder={secretSaved ? 'Saved · leave blank to keep' : '••••••••••••••••••••••••'}
                required={!editing}
                autoComplete="new-password"
                suffix={
                  <button
                    type="button"
                    className="text-muted-foreground text-xs hover:text-foreground"
                    onClick={() => setShow((s) => !s)}
                  >
                    {show ? 'Hide' : 'Show'}
                  </button>
                }
              />
            </div>
            {kind === 's3' || tokenOpen ? (
              <Field
                label="Session token · optional"
                value={f.token}
                onChange={set('token')}
                placeholder="Leave empty for long-lived credentials"
                hint="Required for temporary credentials. This connection needs updating when pasted credentials expire."
                autoComplete="off"
              />
            ) : (
              kind === 's3_compatible' && (
                <button
                  type="button"
                  className="w-max text-brand text-xs leading-[18px] hover:underline"
                  onClick={() => setTokenOpen(true)}
                >
                  Optional session token
                </button>
              )
            )}
            {kind === 'r2' && (
              <p className="text-muted-foreground text-xs leading-[18px]">
                Use an R2 access-key pair with Object Read &amp; Write access to this bucket. Secrets are hidden after
                saving.
              </p>
            )}
            {kind === 's3_compatible' && (
              <p className="text-muted-foreground text-xs leading-[18px]">
                Quiet verifies this connection’s object operations. Other S3 features vary by provider.
              </p>
            )}
          </>
        ) : (
          <Callout title="Use credentials available to this host">
            Quiet uses the AWS credentials configured on its host, including supported instance, task or workload roles.
            No secret needs to be pasted here.
          </Callout>
        )}

        {kind === 's3' && !keys && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-xs leading-[18px]">Required permissions</span>
              <a
                className="text-brand text-xs leading-[18px] hover:underline"
                href="https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies.html"
                target="_blank"
                rel="noreferrer"
              >
                View bucket policy example
              </a>
            </div>
            <p className="text-muted-foreground text-xs leading-[18px]">
              Read, write and delete objects under {prefix}, and list that prefix. Encrypted buckets may also require
              access to their encryption key.
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 border-t pt-4">
          <span className="flex-1 text-muted-foreground text-xs leading-[18px]">
            {kind === 's3' && keys
              ? 'Keys need list, read, write and delete access for the Quiet prefix.'
              : kind === 'r2'
                ? `A test creates, reads and removes a small object in ${prefix}.`
                : ''}
          </span>
          {editing && h && owner && <RemoveButton d={editing} h={h} />}
          <OBtn type="button" onClick={() => go({ tab: 'connectors' })}>
            Cancel
          </OBtn>
          <PBtn type="submit" disabled={!owner || test.isPending}>
            {test.isPending ? 'Testing…' : 'Test connection'}
          </PBtn>
        </div>
      </form>
    </StorageFrame>
  )
}
