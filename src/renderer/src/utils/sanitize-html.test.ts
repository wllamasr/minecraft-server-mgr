// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { sanitizeRemoteHtml } from './sanitize-html'

describe('sanitizeRemoteHtml', () => {
  it('keeps ordinary formatting', () => {
    const out = sanitizeRemoteHtml('<h2>Title</h2><p>Some <strong>bold</strong> text</p>')
    expect(out).toContain('<h2>Title</h2>')
    expect(out).toContain('<strong>bold</strong>')
  })

  it('removes script tags', () => {
    const out = sanitizeRemoteHtml('<p>hi</p><script>window.api.deleteServer("x")</script>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('deleteServer')
  })

  it('removes inline event handlers', () => {
    const out = sanitizeRemoteHtml('<img src="x" onerror="window.api.deleteServer(1)">')
    expect(out).not.toContain('onerror')
  })

  it('removes javascript: links', () => {
    const out = sanitizeRemoteHtml('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toContain('javascript:')
  })

  it('removes frames and forms', () => {
    const out = sanitizeRemoteHtml(
      '<iframe src="https://evil.test"></iframe><form action="https://evil.test"><input name="a"></form>'
    )
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<form')
    expect(out).not.toContain('<input')
  })

  it('tolerates empty input', () => {
    expect(sanitizeRemoteHtml('')).toBe('')
  })
})
