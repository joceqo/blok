import { WorkspaceSection } from './tree-section';
import './sidebar-skeleton.css';

const LoadingRows = ({ heading = false }: { heading?: boolean }) => (
  <div
    className="sidebar-skeleton sidebar-skeleton-pages"
    aria-hidden="true"
  >
    {heading && <div className="sidebar-skeleton-heading" />}
    <div className="sidebar-skeleton-rows" />
  </div>
);

export const SidebarPageSkeleton = ({ teamspace }: { teamspace?: string }) => (
  <>
    <LoadingRows heading />
    {teamspace && (
      <WorkspaceSection name={teamspace}>
        <LoadingRows />
      </WorkspaceSection>
    )}
  </>
);
