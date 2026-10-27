import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, collection, getDocs, doc, writeBatch, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

/* One-time migration: copies legacy userLocks/userExpiry access into the new
   /access/{uid}/resources/{type_id} model. It never deletes legacy fields.
   Run only by an authorized admin after deploying the new rules. */

const app=getApp(), auth=getAuth(app), db=getFirestore(app);
const key=(t,id)=>`${t}_${String(id).replace(/[^A-Za-z0-9_-]/g,'')}`;
const ms=v=>!v?0:v.toMillis?v.toMillis():v.seconds?v.seconds*1000:Number(v)||0;
async function read(name){return (await getDocs(collection(db,name))).docs.map(d=>({id:d.id,...d.data()}));}

export async function migrateLegacyAccess(onProgress=()=>{}){
  if(!auth.currentUser) throw new Error('Not signed in.');
  const [students,mods,subs,pkgs]=await Promise.all([read('secretkeys'),read('modules'),read('subjects'),read('packages')]);
  const qBy=[]; for(const s of subs){const q=await getDocs(collection(db,'subjects',s.id,'quizzes'));q.forEach(d=>qBy.push({id:d.id,subjectId:s.id,...d.data()}));}
  const maps=[['module',mods],['subject',subs],['quiz',qBy]];
  let writes=0; const batches=[]; let batch=writeBatch(db); let batchOps=0;
  const commit=async()=>{if(!batchOps)return;await batch.commit();batches.push(1);batch=writeBatch(db);batchOps=0;};
  for(const st of students){ if(!st.authUid) continue;
    for(const [type,arr] of maps) for(const item of arr){
      const legacy=item.userLocks?.[st.id]; if(legacy!==false && legacy!=='enrolled') continue;
      const exp=item.userExpiry?.[st.id]; const ref=doc(db,'access',st.authUid,'resources',key(type,item.id));
      batch.set(ref,{resourceType:type,resourceId:item.id,resourceLabel:item.name||item.title||item.id,mode:'allow',status:'active',expiresAt:exp?exp:null,sourceType:'legacy-migration',sourceId:null,sourceLabel:'Migrated legacy access',updatedAt:serverTimestamp(),updatedBy:auth.currentUser.uid},{merge:true});
      batchOps++; writes++; if(batchOps>=450) await commit();
    }
    // Legacy bundle enrollment was stored on the package itself.
    for(const pkg of pkgs){ if(pkg.userLocks?.[st.id]!=='enrolled') continue;
      for(const id of (pkg.moduleIds||[])){batch.set(doc(db,'access',st.authUid,'resources',key('module',id)),{resourceType:'module',resourceId:id,mode:'allow',status:'active',sourceType:'bundle',sourceId:pkg.id,sourceLabel:pkg.name||'Bundle',updatedAt:serverTimestamp(),updatedBy:auth.currentUser.uid},{merge:true});batchOps++;writes++;if(batchOps>=450)await commit();}
      for(const id of (pkg.subjectIds||[])){batch.set(doc(db,'access',st.authUid,'resources',key('subject',id)),{resourceType:'subject',resourceId:id,mode:'allow',status:'active',sourceType:'bundle',sourceId:pkg.id,sourceLabel:pkg.name||'Bundle',updatedAt:serverTimestamp(),updatedBy:auth.currentUser.uid},{merge:true});batchOps++;writes++;if(batchOps>=450)await commit();}
    }
    onProgress(st);
  }
  await commit(); return {students:students.length,writes};
}
