import {executeCode,executionPassed} from '../api/codingRunner.mjs';
const programs={
 python:'a,b=map(int,input().split())\nprint(a+b)',
 c:'#include <stdio.h>\nint main(){int a,b;scanf("%d%d",&a,&b);printf("%d",a+b);return 0;}',
 cpp:'#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}',
 java:'import java.util.*; public class Main { public static void main(String[] args) { Scanner s=new Scanner(System.in); System.out.print(s.nextInt()+s.nextInt()); } }'
};
for (const [language,code] of Object.entries(programs)) {
 try { const result=await executeCode({code,language,stdin:'2 3'});console.log(JSON.stringify({language,passed:executionPassed(result,'5'),responseFields:Object.keys(result)})); }
 catch(e){console.log(JSON.stringify({language,error:e.message}));}
}
