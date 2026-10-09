import { expect } from 'chai';
import { diagramFileName } from './diagram-session-label.js';

describe('diagram-session-label', () => {
	describe('diagramFileName', () => {
		it('takes the last segment of a document uri', () => {
			expect(diagramFileName('file:///c%3A/projects/db2-workbench/sample.db2diagram')).to.equal('sample.db2diagram');
		});

		it('percent-decodes the name, so a space survives the round trip through the uri', () => {
			expect(diagramFileName('file:///c%3A/temp/order%20entry.db2diagram')).to.equal('order entry.db2diagram');
		});

		it('returns the whole string when there is no path separator at all', () => {
			expect(diagramFileName('sample.db2diagram')).to.equal('sample.db2diagram');
		});

		it('falls back to the raw segment rather than throwing on an undecodable escape', () => {
			expect(diagramFileName('file:///c%3A/temp/100%_done.db2diagram')).to.equal('100%_done.db2diagram');
		});

		it('falls back to the whole uri when it ends in a separator, leaving no name to take', () => {
			expect(diagramFileName('file:///c%3A/temp/')).to.equal('file:///c%3A/temp/');
		});
	});
});
