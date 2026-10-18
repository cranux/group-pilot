import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../components/Layout';
import { SequenceRunProgress } from '../components/SequenceRunProgress';

export function SequenceRunPage() {
  const { id = '' } = useParams();
  return (
    <div>
      <PageHeader
        title={
          <>
            序列运行 <span className="mono">{id}</span>
          </>
        }
      >
        <Link to="/groups" className="btn btn-sm">
          群列表
        </Link>
      </PageHeader>
      <div className="card">
        <div className="card-body">
          <SequenceRunProgress runId={id} />
        </div>
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div>
      <PageHeader title="页面不存在" />
      <Link to="/accounts">返回首页</Link>
    </div>
  );
}
