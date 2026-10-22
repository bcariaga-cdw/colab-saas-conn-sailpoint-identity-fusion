import { FusionAccount } from '../../model/account'
import { OrphanProcessingMode, SourceType } from '../../model/config'
import { UrlContext } from '../../utils/url'
import { capitalizeFirst } from '../../utils/attributes'
import { translate, translateWithParams, scoreAttributeLabel } from '../emailService/localization'
import { ALGORITHM_LABELS } from './constants'
import { Candidate, Score } from './types'

/** Launch-time formInput key for account-context DESCRIPTION HTML. */
export const FORM_HTML_ACCOUNT_INPUT = 'accountHtml'

/** Launch-time formInput key for candidate score-table DESCRIPTION HTML. */
export const FORM_HTML_CANDIDATES_INPUT = 'candidatesHtml'

const LINK_COLOR = '#0b5cab'
const MATCH_ROW_BG = '#f0fdf4'
const MISS_ROW_BG = '#fef2f2'
const FUSION_ROW_BG = '#e0f2fe'
const TEXT_COLOR = '#0f172a'
const MUTED_COLOR = '#4a5566'
const BORDER_COLOR = '#d7dfea'
const HEADER_BG = '#eef3fb'
const LABEL_BG = '#f8fafc'
const CARD_BG = '#ffffff'

/**
 * Self-contained light surface for a DESCRIPTION fragment. ISC renders the
 * review form inside the tenant theme, which is dark in dark mode; the inline
 * email colour tokens below assume a light background, so every fragment is
 * wrapped in its own opaque card to stay readable in either theme.
 */
const CARD_STYLE =
    `background:${CARD_BG};color:${TEXT_COLOR};border:1px solid ${BORDER_COLOR};` +
    `border-radius:12px;padding:16px 18px;margin:0 0 20px 0;box-sizing:border-box;`

const TABLE_STYLE = `width:100%;border-collapse:collapse;table-layout:auto;margin:12px 0 28px 0;border:1px solid ${BORDER_COLOR};`
const TH_STYLE =
    `text-align:left;padding:10px 14px;border:1px solid ${BORDER_COLOR};background:${HEADER_BG};` +
    `color:${MUTED_COLOR};font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;` +
    `white-space:nowrap;word-break:keep-all;overflow-wrap:normal;`
const TD_STYLE = `padding:10px 14px;border:1px solid ${BORDER_COLOR};background:${CARD_BG};color:${TEXT_COLOR};font-size:14px;line-height:1.45;`
const TD_NUMERIC_STYLE = `${TD_STYLE}text-align:right;white-space:nowrap;`
const TD_ATTR_LABEL_STYLE = `${TD_STYLE}width:220px;background:${LABEL_BG};color:${MUTED_COLOR};font-weight:600;`

const HEADER_P_STYLE = 'margin:0 0 18px 0;text-align:center;'
const HEADER_SPAN_STYLE = `font-size:24px;line-height:1.3;color:${LINK_COLOR};`
const BODY_P_STYLE = `margin:0 0 16px 0;font-size:15px;line-height:1.6;color:${TEXT_COLOR};`
const ACCOUNT_LINK_P_STYLE = `margin:24px 0 4px 0;font-size:19px;font-weight:800;color:${LINK_COLOR};`
const CANDIDATE_NAME_P_STYLE = `margin:26px 0 4px 0;font-size:17px;font-weight:800;color:${LINK_COLOR};`

export type AccountDisplayHtmlArgs = {
    accountLabel: string
    sourceName: string
    attributes: Record<string, unknown>
    fusionFormAttributes?: string[]
    locale?: string
    urlContext?: UrlContext
    accountIscId?: string
    sourceType?: SourceType
    orphanProcessingMode?: OrphanProcessingMode
    isMachine?: boolean
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)

const getAttrValue = (attrs: Record<string, unknown> | undefined, name: string): string =>
    String(attrs?.[name] ?? attrs?.[lowerFirst(name)] ?? '')

/**
 * HTML-escapes untrusted text for DESCRIPTION content.
 */
export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/**
 * Renders an ISC UI anchor when a URL exists; otherwise escaped plain text.
 */
export function renderIscUiLink(label: string, url: string | undefined): string {
    const text = escapeHtml(label)
    if (!url) {
        return text
    }
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:${LINK_COLOR};text-decoration:underline;">${text}</a>`
}

/**
 * Custom Forms DESCRIPTION interpolation of a launch-time formInput key.
 */
export function formInputInterpolation(key: string): string {
    return `{{$.form.input.${key}}}`
}

/**
 * Wraps a DESCRIPTION fragment in an opaque light card so dark text stays
 * readable when ISC renders the form inside a dark theme.
 */
function renderCard(inner: string): string {
    return `<div style="${CARD_STYLE}">${inner}</div>`
}

function isAverageScoreRow(attribute?: string, algorithm?: string): boolean {
    const attr = String(attribute ?? '')
    const alg = String(algorithm ?? '')
    return (
        attr === 'Average Score' ||
        attr === 'Combined score' ||
        attr === 'Combined match score' ||
        alg === 'average' ||
        alg === 'weighted-mean'
    )
}

function formatPercent(value: unknown): string {
    const num = typeof value === 'number' ? value : Number.parseFloat(String(value))
    if (Number.isNaN(num)) {
        return '0'
    }
    return String(Math.round(num))
}

function algorithmLabel(algorithmKey: string, locale: string): string {
    const normalized = algorithmKey.replace(/-/g, '_')
    const key = `algorithm_${normalized}`
    const translated = translate(key, locale)
    return translated !== key ? translated : (ALGORITHM_LABELS[algorithmKey] ?? algorithmKey)
}

function scoreRowBackground(score: Score): string {
    if (isAverageScoreRow(score.attribute, score.algorithm)) {
        return FUSION_ROW_BG
    }
    return score.isMatch ? MATCH_ROW_BG : MISS_ROW_BG
}

/** Raw comparison percentage for the scored attribute. */
function resultCell(score: Score): string {
    if (score.skipped || isAverageScoreRow(score.attribute, score.algorithm)) {
        return '—'
    }
    const raw = Number(score.score)
    return Number.isFinite(raw) ? `${formatPercent(raw)}%` : '—'
}

/** The candidate's own value for the scored attribute. */
function attributeValueCell(attributes: Record<string, unknown> | undefined, score: Score): string {
    if (isAverageScoreRow(score.attribute, score.algorithm)) {
        return '—'
    }
    const raw = getAttrValue(attributes, String(score.attribute ?? ''))
    return raw ? escapeHtml(raw) : '—'
}

function scoreCell(score: Score): string {
    if (score.skipped) {
        return '—'
    }
    if (isAverageScoreRow(score.attribute, score.algorithm)) {
        const s = Number(score.score)
        return Number.isFinite(s) ? `${formatPercent(s)}%` : '—'
    }
    if (typeof score.weightedScore === 'number' && Number.isFinite(score.weightedScore)) {
        return `${formatPercent(score.weightedScore)}%`
    }
    return '—'
}

function thresholdCell(score: Score): string {
    const t = Number(score.fusionScore)
    return Number.isFinite(t) ? `${formatPercent(t)}%` : '—'
}

/**
 * Two-column table of the configured form attributes for one account or candidate identity.
 * Returns an empty string when no attributes are configured.
 */
function renderAttributeTable(
    attributes: Record<string, unknown> | undefined,
    fusionFormAttributes: string[] | undefined,
    locale: string
): string {
    const rows = (fusionFormAttributes ?? [])
        .map((attrName) => {
            const label = escapeHtml(capitalizeFirst(attrName))
            const raw = getAttrValue(attributes, attrName)
            const value = raw ? escapeHtml(raw) : '—'
            return `<tr><td style="${TD_ATTR_LABEL_STYLE}"><strong>${label}</strong></td><td style="${TD_STYLE}">${value}</td></tr>`
        })
        .join('')

    if (!rows) {
        return ''
    }

    return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${TABLE_STYLE}">` +
        `<tr><th nowrap style="${TH_STYLE}">${escapeHtml(translate('attribute', locale))}</th>` +
        `<th nowrap style="${TH_STYLE}">${escapeHtml(translate('value', locale))}</th></tr>` +
        rows +
        `</table>`
    )
}

/**
 * Account context HTML: header, source, optional Accounts Management link, configured form attributes.
 */
export function renderAccountDisplayHtml(args: AccountDisplayHtmlArgs): string {
    const locale = args.locale ?? 'en'
    const sectionKey =
        args.sourceType === SourceType.Record
            ? 'form_section_desc_record'
            : args.sourceType === SourceType.Orphan && args.orphanProcessingMode === OrphanProcessingMode.Ownership
              ? 'form_section_desc_ownership'
              : args.sourceType === SourceType.Orphan
                ? 'form_section_desc_orphan'
                : 'form_section_desc_authoritative'
    const header = escapeHtml(
        translateWithParams('form_review_required_header', locale, { sourceName: args.sourceName })
    )
    const sourceTypeNote = escapeHtml(translate(sectionKey, locale))
    const accountLink = renderIscUiLink(
        args.accountLabel,
        args.urlContext?.accountManagement(args.accountIscId, args.isMachine)
    )
    const sourceLabel = escapeHtml(translate('source', locale))
    const sourceValue = escapeHtml(args.sourceName)

    const attrTable = renderAttributeTable(args.attributes, args.fusionFormAttributes, locale)

    return renderCard(
        `<p style="${HEADER_P_STYLE}"><span style="${HEADER_SPAN_STYLE}"><strong>${header}</strong></span></p>` +
            `<p style="${BODY_P_STYLE}">${sourceTypeNote}</p>` +
            `<p style="${ACCOUNT_LINK_P_STYLE}">${accountLink}</p>` +
            `<p style="${BODY_P_STYLE}">${sourceLabel} <span style="color:${LINK_COLOR};">${sourceValue}</span></p>` +
            attrTable
    )
}

function renderCandidateScoreTable(candidate: Candidate, locale: string): string {
    const scoreRows = candidate.scores
        .filter((score) => score.attribute && score.score !== undefined)
        .map((score) => {
            const bg = scoreRowBackground(score)
            const cellBg = `background:${bg};`
            const attr = escapeHtml(scoreAttributeLabel(String(score.attribute), locale))
            const algo = escapeHtml(algorithmLabel(String(score.algorithm ?? 'unknown'), locale))
            const weight = isAverageScoreRow(score.attribute, score.algorithm) ? 'font-weight:900;' : ''
            return (
                `<tr>` +
                `<td style="${TD_STYLE}${cellBg}${weight}">${attr}</td>` +
                `<td style="${TD_STYLE}${cellBg}${weight}">${attributeValueCell(candidate.attributes, score)}</td>` +
                `<td style="${TD_STYLE}${cellBg}${weight}">${algo}</td>` +
                `<td style="${TD_NUMERIC_STYLE}${cellBg}${weight}">${thresholdCell(score)}</td>` +
                `<td style="${TD_NUMERIC_STYLE}${cellBg}">${resultCell(score)}</td>` +
                `<td style="${TD_NUMERIC_STYLE}${cellBg}font-weight:900;">${scoreCell(score)}</td>` +
                `</tr>`
            )
        })
        .join('')

    if (!scoreRows) {
        return ''
    }

    const th = (key: string, numeric = false) =>
        `<th nowrap style="${TH_STYLE}${numeric ? 'text-align:right;' : ''}">${escapeHtml(translate(key, locale))}</th>`
    return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${TABLE_STYLE}">` +
        `<tr>${th('attribute')}${th('value')}${th('algorithm')}${th('threshold', true)}${th('result', true)}${th('score', true)}</tr>` +
        scoreRows +
        `</table>`
    )
}

/**
 * One HTML block listing every form candidate with score tables, attribute values and identity links.
 */
export function renderCandidatesDisplayHtml(candidates: Candidate[], locale = 'en', urlContext?: UrlContext): string {
    const inner = candidates
        .filter((candidate) => candidate?.id && candidate.name)
        .map((candidate) => {
            const nameLink = renderIscUiLink(candidate.name, urlContext?.identity(candidate.id))
            return `<p style="${CANDIDATE_NAME_P_STYLE}">${nameLink}</p>` + renderCandidateScoreTable(candidate, locale)
        })
        .join('')
    return inner ? renderCard(inner) : ''
}

/**
 * Selected identity DESCRIPTION HTML with the identity link and configured form attributes.
 */
export function renderIdentityDetailsHtml(
    candidate: Candidate,
    fusionFormAttributes: string[] | undefined,
    locale = 'en',
    urlContext?: UrlContext
): string {
    const nameLink = renderIscUiLink(candidate.name, urlContext?.identity(candidate.id))
    const heading = translateWithParams('form_candidate_details', locale, { name: nameLink })
    return renderCard(
        `<p style="${CANDIDATE_NAME_P_STYLE}">${heading}</p>` +
            renderAttributeTable(candidate.attributes, fusionFormAttributes, locale)
    )
}

/**
 * Account-context DESCRIPTION HTML for a Fusion review, including UrlContext links when available.
 */
export function renderFusionAccountHtml(
    fusionAccount: FusionAccount,
    fusionFormAttributes: string[] | undefined,
    locale: string,
    urlContext?: UrlContext,
    sourceType?: SourceType,
    orphanProcessingMode?: OrphanProcessingMode
): string {
    const managedKey = fusionAccount.managedAccountId ?? fusionAccount.managedKey ?? ''
    const accountLabel =
        fusionAccount.identityDisplayName || fusionAccount.name || fusionAccount.displayName || managedKey
    return renderAccountDisplayHtml({
        accountLabel,
        sourceName: fusionAccount.sourceName ?? '',
        attributes: (fusionAccount.attributes ?? {}) as Record<string, unknown>,
        fusionFormAttributes,
        locale,
        urlContext,
        accountIscId: fusionAccount.iscAccountId,
        sourceType,
        orphanProcessingMode,
        isMachine: fusionAccount.isMachine === true,
    })
}
