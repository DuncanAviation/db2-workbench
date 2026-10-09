import { expect } from 'chai';
import { shouldShowSchemaTableCount, tierForZoom } from './diagram-zoom-tiers.js';

describe('diagram-zoom-tiers', () => {
	describe('tierForZoom', () => {
		it('is "cluster" well below the cluster threshold', () => {
			expect(tierForZoom(0.01)).to.equal('cluster');
		});

		it('is "collapsed" between the cluster and expanded thresholds', () => {
			expect(tierForZoom(0.3)).to.equal('collapsed');
		});

		it('is "expanded" at and above the expanded threshold', () => {
			expect(tierForZoom(0.55)).to.equal('expanded');
			expect(tierForZoom(2)).to.equal('expanded');
		});

		it('is "collapsed", not "cluster", exactly at the cluster threshold (boundary is inclusive on the higher tier)', () => {
			expect(tierForZoom(0.15)).to.equal('collapsed');
		});
	});

	describe('shouldShowSchemaTableCount', () => {
		it('is true at a normal cluster-tier zoom', () => {
			expect(shouldShowSchemaTableCount(0.1)).to.be.true;
		});

		it('is false once zoomed out past the name-only threshold', () => {
			expect(shouldShowSchemaTableCount(0.01)).to.be.false;
		});

		it('is true exactly at the name-only threshold (boundary is inclusive on the "show" side)', () => {
			expect(shouldShowSchemaTableCount(0.05)).to.be.true;
		});
	});
});
