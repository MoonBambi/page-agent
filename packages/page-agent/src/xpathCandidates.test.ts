import { describe, expect, it } from 'vitest'

import { referencesIdAttribute, sanitizeXpathCandidates } from './xpathCandidates'

describe('referencesIdAttribute', () => {
	it.each([
		"//*[@id='submit']",
		'//input[@id = "q"]',
		'//*[@id]',
		"//div[@id='x']//button",
		"//*[contains(@id, 'row')]",
	])('flags %s', (xpath) => {
		expect(referencesIdAttribute(xpath)).toBe(true)
	})

	it.each([
		"//input[@placeholder='搜索应用']",
		"//*[@data-id='42']",
		"//*[@data-testid='submit']",
		"//button[.='确认']",
		"//*[@aria-labelledby='title']",
	])('accepts %s', (xpath) => {
		expect(referencesIdAttribute(xpath)).toBe(false)
	})
})

describe('sanitizeXpathCandidates', () => {
	it('drops id-based candidates and keeps the rest in order', () => {
		expect(
			sanitizeXpathCandidates([
				"//*[@id='app']//input",
				"//input[@placeholder='搜索应用']",
				"//*[@data-testid='search']",
			])
		).toEqual({
			candidates: ["//input[@placeholder='搜索应用']", "//*[@data-testid='search']"],
			droppedForId: 1,
		})
	})

	it('trims, de-duplicates and ignores non-strings', () => {
		expect(
			sanitizeXpathCandidates([
				'  //button[.="Go"]  ',
				'//button[.="Go"]',
				'   ',
				42,
				null,
				"//form[@class='el-form']",
			])
		).toEqual({ candidates: ['//button[.="Go"]', "//form[@class='el-form']"], droppedForId: 0 })
	})

	it('caps the number of candidates', () => {
		const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => `//*[@title='${t}']`)
		expect(sanitizeXpathCandidates(many).candidates).toHaveLength(5)
		expect(sanitizeXpathCandidates(many, 2).candidates).toHaveLength(2)
	})

	it('reports how many candidates the id rule removed', () => {
		// The signal a model ignoring the prompt leaves behind.
		expect(
			sanitizeXpathCandidates(["//*[@id='a']", '//div[@id = "b"]', '//input[@name="q"]'])
		).toEqual({ candidates: ['//input[@name="q"]'], droppedForId: 2 })
	})

	it('returns nothing usable when there is nothing to sanitize', () => {
		expect(sanitizeXpathCandidates(["//*[@id='a']"])).toEqual({ candidates: [], droppedForId: 1 })
		expect(sanitizeXpathCandidates(undefined)).toEqual({ candidates: [], droppedForId: 0 })
		expect(sanitizeXpathCandidates('//input')).toEqual({ candidates: [], droppedForId: 0 })
	})
})
