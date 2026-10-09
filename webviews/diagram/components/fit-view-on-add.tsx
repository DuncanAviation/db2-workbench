import { useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';

// Re-frames the canvas whenever tables are added to the diagram. ReactFlow's own `fitView` prop only
// applies on mount, so without this an "Add to Diagram" would drop tables somewhere off the current
// viewport and look like it had done nothing at all - most obviously on a brand-new diagram, where the
// mount-time fit ran against an empty canvas.
//
// Has to be a child of <ReactFlow> rather than a hook in the app component, since useReactFlow only
// works inside the provider ReactFlow itself sets up (same reason DiagramControls is a component).
interface Props {
	// Deliberately the COUNT, not the ids: a growing count is exactly the "tables were added" signal, and
	// it can't be accidentally re-triggered by a drag (which changes positions, not the count) or by an
	// array identity that changes on every render. A removal lowers it and is correctly ignored - the user
	// hasn't asked to look anywhere new.
	tableCount: number;
}

export function FitViewOnAdd({ tableCount }: Props) {
	let { fitView } = useReactFlow();
	let previousCount = useRef(tableCount);

	useEffect(() => {
		let grew = tableCount > previousCount.current;
		previousCount.current = tableCount;

		if(!grew) {
			return;
		}

		// Deferred a tick because ReactFlow copies the `nodes` prop into its own store in an effect of its
		// own, and the order between that and this one isn't guaranteed - fitting synchronously here can
		// measure the node set from before the add.
		let timer = setTimeout(() => void fitView({padding: 0.15}), 0);

		return () => clearTimeout(timer);
	}, [tableCount, fitView]);

	return null;
}
